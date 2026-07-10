// GET /api/track-record
// Aggregates graded prop and game picks into hit rates by confidence tier,
// over last-7-day, last-30-day, and all-time windows, plus a recent picks log.

import { NextResponse } from 'next/server';
import { getTrackRecord } from '../../../lib/gradeStore';
import { TrackRecordAPIResponse } from '../../../types';

export async function GET(): Promise<NextResponse> {
  const { windows, recentLog, gradedDateCount } = await getTrackRecord();

  const body: TrackRecordAPIResponse = {
    windows,
    recentLog,
    gradedDateCount,
    generatedAt: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
