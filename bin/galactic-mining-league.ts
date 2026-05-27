#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GalacticMiningLeagueStack } from '../lib/galactic-mining-league-stack';

const app = new cdk.App();
new GalacticMiningLeagueStack(app, 'GalacticMiningLeagueStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
