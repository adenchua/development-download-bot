import { ObjectId, WithId } from "mongodb";

import { getDb } from ".";

const COLLECTION = "jobs";

export interface Job {
  clientId: ObjectId;
  jobId: string;
  startedAt: Date;
  serviceType?: "npm" | "python";
  status?: "success" | "failed";
  completedAt?: Date;
  completedBy?: number;
}

export type JobDocument = WithId<Job>;

function col() {
  return getDb().collection<Job>(COLLECTION);
}

export async function ensureIndexes(): Promise<void> {
  await col().createIndex({ jobId: 1 }, { unique: true, name: "job" });
  await col().createIndex({ clientId: 1 }, { name: "jobsByClient" });
  await col().createIndex({ startedAt: -1 }, { name: "jobsByDate" });
}

export async function addJob(data: Job): Promise<void> {
  await col().insertOne(data);
}

export async function getPendingJobs(limit: number, maxAgeDays?: number): Promise<JobDocument[]> {
  const filter: Record<string, unknown> = { status: { $exists: false } };
  if (maxAgeDays !== undefined) {
    filter.startedAt = { $gte: new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) };
  }
  return col().find(filter).sort({ startedAt: -1 }).limit(limit).toArray();
}

export async function updateJobStatus(
  jobId: string,
  status: "success" | "failed",
  completedBy: number,
): Promise<boolean> {
  const result = await col().updateOne({ jobId }, { $set: { status, completedAt: new Date(), completedBy } });
  return result.matchedCount > 0;
}

export async function getJobByJobId(jobId: string): Promise<JobDocument | null> {
  return col().findOne({ jobId });
}
