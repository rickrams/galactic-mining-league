import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontorigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

export class GalacticMiningLeagueStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // VPC: 2 AZs, isolated subnets only (no NAT, no IGW — fully private)
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'GalacticVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // VPC Endpoints — Lambda PrivateLink for fan-out invocation
    // -------------------------------------------------------------------------
    vpc.addInterfaceEndpoint('LambdaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.LAMBDA,
      privateDnsEnabled: true,
    });

    // -------------------------------------------------------------------------
    // Security Groups
    // -------------------------------------------------------------------------
    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Security group for Lambda functions',
      allowAllOutbound: false,
    });

    const valkeySg = new ec2.SecurityGroup(this, 'ValkeySg', {
      vpc,
      description: 'Security group for ElastiCache Valkey cluster',
      allowAllOutbound: false,
    });

    // Lambda → Valkey on port 6379
    lambdaSg.addEgressRule(valkeySg, ec2.Port.tcp(6379), 'Lambda to Valkey');
    valkeySg.addIngressRule(lambdaSg, ec2.Port.tcp(6379), 'Valkey from Lambda');

    // Lambda → VPC Endpoints (Lambda PrivateLink) via HTTPS
    lambdaSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Lambda to VPC endpoints (HTTPS)');

    // -------------------------------------------------------------------------
    // ElastiCache Valkey 9.0 (node-based, Multi-AZ, synchronous durability)
    // -------------------------------------------------------------------------
    const privateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'ValkeySubnetGroup', {
      description: 'Subnet group for Galactic Mining Valkey cluster',
      subnetIds: privateSubnets.subnetIds,
      cacheSubnetGroupName: 'galactic-mining-subnets',
    });

    const valkeyCluster = new elasticache.CfnReplicationGroup(this, 'ValkeyCluster', {
      replicationGroupDescription: 'Galactic Mining League durable Valkey cluster',
      engine: 'valkey',
      engineVersion: '9.0',
      cacheNodeType: 'cache.r7g.large',
      numNodeGroups: 1,
      replicasPerNodeGroup: 1,
      multiAzEnabled: true,
      automaticFailoverEnabled: true,
      cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
      securityGroupIds: [valkeySg.securityGroupId],
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      dataTieringEnabled: false,
      clusterMode: 'enabled',
    });
    valkeyCluster.addDependency(subnetGroup);
    valkeyCluster.addPropertyOverride('Durability', 'sync');

    const valkeyEndpoint = `${valkeyCluster.attrConfigurationEndPointAddress}:${valkeyCluster.attrConfigurationEndPointPort}`;

    // -------------------------------------------------------------------------
    // Lambda: worker
    // -------------------------------------------------------------------------
    const workerLambda = new NodejsFunction(this, 'WorkerLambda', {
      functionName: 'galactic-mining-worker',
      runtime: lambda.Runtime.NODEJS_22_X,
      logRetention: logs.RetentionDays.THREE_DAYS,
      entry: path.join(__dirname, '../lambda/worker/handler.js'),
      handler: 'handler',
      depsLockFilePath: path.join(__dirname, '../lambda/package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@valkey/valkey-glide', '@valkey/valkey-glide-linux-x64-gnu'],
        sourceMap: false,
        forceDockerBundling: true,
      },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        VALKEY_ENDPOINT: valkeyEndpoint,
      },
    });

    // -------------------------------------------------------------------------
    // Lambda: api
    // -------------------------------------------------------------------------
    const apiLambda = new NodejsFunction(this, 'ApiLambda', {
      functionName: 'galactic-mining-api',
      runtime: lambda.Runtime.NODEJS_22_X,
      logRetention: logs.RetentionDays.THREE_DAYS,
      entry: path.join(__dirname, '../lambda/api/handler.js'),
      handler: 'handler',
      depsLockFilePath: path.join(__dirname, '../lambda/package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@valkey/valkey-glide', '@valkey/valkey-glide-linux-x64-gnu'],
        sourceMap: false,
        forceDockerBundling: true,
      },
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSg],
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        VALKEY_ENDPOINT: valkeyEndpoint,
        WORKER_LAMBDA_ARN: workerLambda.functionArn,
      },
    });

    // Grant api lambda permission to invoke the worker lambda
    apiLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [workerLambda.functionArn],
      }),
    );

    // -------------------------------------------------------------------------
    // API Gateway HTTP API
    // -------------------------------------------------------------------------
    const httpApi = new apigatewayv2.HttpApi(this, 'GalacticHttpApi', {
      apiName: 'galactic-mining-league-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const apiIntegration = new apigatewayv2integrations.HttpLambdaIntegration(
      'ApiLambdaIntegration',
      apiLambda,
    );

    httpApi.addRoutes({
      path: '/leaderboard',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships/{id}/rank',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships/{id}/score',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/simulation/start',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/leaderboard',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/leaderboard/windows',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/leaderboard/stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/leaderboard/above/{threshold}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/leaderboard/topn',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships/seed',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/ships/generate',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/loadtest/start',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/loadtest/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/loadtests',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    httpApi.addRoutes({
      path: '/events',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    // -------------------------------------------------------------------------
    // S3 bucket for frontend (private, CloudFront OAC access only)
    // -------------------------------------------------------------------------
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `galactic-mining-league-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // -------------------------------------------------------------------------
    // CloudFront OAC + Distribution
    // -------------------------------------------------------------------------
    const oac = new cloudfront.S3OriginAccessControl(this, 'FrontendOac', {
      description: 'OAC for Galactic Mining League frontend',
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    const distribution = new cloudfront.Distribution(this, 'FrontendDistribution', {
      defaultBehavior: {
        origin: cloudfrontorigins.S3BucketOrigin.withOriginAccessControl(frontendBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    // -------------------------------------------------------------------------
    // Frontend deployment: React build + config.js injected at deploy time
    // -------------------------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '../frontend/build')),
        s3deploy.Source.jsonData('config.json', {
          apiUrl: httpApi.apiEndpoint,
        }),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // -------------------------------------------------------------------------
    // Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      description: 'API Gateway HTTP API URL',
      value: httpApi.apiEndpoint,
      exportName: 'GalacticMiningLeagueApiUrl',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      description: 'CloudFront distribution URL',
      value: `https://${distribution.distributionDomainName}`,
      exportName: 'GalacticMiningLeagueFrontendUrl',
    });
  }
}
