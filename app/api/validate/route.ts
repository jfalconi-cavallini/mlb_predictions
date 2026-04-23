// GET /api/validate
// Runs the regression test suite from lib/validation.ts.
// Returns pass/fail for each VULN-* patch.

import { NextResponse } from 'next/server';
import {
  testRejectCadeCunningham,
  testNormalizedNameRejection,
  testRejectInvalidTeamId,
  testHitterPositionFilter,
  testDeduplication,
  testGamePkZeroRejection,
  testTeamIdCrossCheck,
  testNullStatusRejection,
} from '../../../lib/validation';

interface TestResult {
  name: string;
  vuln: string;
  passed: boolean;
  description: string;
}

export async function GET(): Promise<NextResponse> {
  const results: TestResult[] = [
    {
      name: 'testNullStatusRejection',
      vuln: 'VULN-01',
      passed: testNullStatusRejection(),
      description: 'Null/missing roster status code is rejected, not treated as active',
    },
    {
      name: 'testTeamIdCrossCheck',
      vuln: 'VULN-05',
      passed: testTeamIdCrossCheck(),
      description: 'queriedTeamId mismatch triggers rejection — prevents player/team spoofing',
    },
    {
      name: 'testNormalizedNameRejection',
      vuln: 'VULN-06',
      passed: testNormalizedNameRejection(),
      description: 'Non-MLB name variants (lowercase, double-space, caps) all rejected',
    },
    {
      name: 'testHitterPositionFilter',
      vuln: 'VULN-07',
      passed: testHitterPositionFilter(),
      description: 'Lowercase position strings (p, sp) and non-baseball positions rejected',
    },
    {
      name: 'testGamePkZeroRejection',
      vuln: 'VULN-04',
      passed: testGamePkZeroRejection(),
      description: 'gamePk=0 and missing gamePk are hard rejections, not silent false-VALID',
    },
    {
      name: 'testDeduplication',
      vuln: 'VULN-09',
      passed: testDeduplication(),
      description: 'Duplicate player IDs from same roster are deduplicated correctly',
    },
    {
      name: 'testRejectCadeCunningham',
      vuln: 'CANARY-ID',
      passed: testRejectCadeCunningham(),
      description: 'Known non-MLB canary player ID and name both trigger WRONG_SPORT rejection',
    },
    {
      name: 'testRejectInvalidTeamId',
      vuln: 'TEAM-ID',
      passed: testRejectInvalidTeamId(),
      description: 'Non-MLB team IDs (9999, 0, -1) are not in VALID_MLB_TEAM_IDS',
    },
  ];

  const allPassed = results.every(r => r.passed);
  const passCount = results.filter(r => r.passed).length;

  return NextResponse.json({
    status: allPassed ? 'ALL_PASS' : 'FAILURES_DETECTED',
    passCount,
    totalCount: results.length,
    results,
    ranAt: new Date().toISOString(),
  }, {
    status: allPassed ? 200 : 500,
  });
}
