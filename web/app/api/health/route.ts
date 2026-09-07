import { NextResponse } from "next/server";
import { persistentStorageConfigured, storageBackend } from "@/lib/server/store";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "floor-ceiling-web",
    version: "0.1.0",
    publicDemo: true,
    persistentWorker: Boolean(process.env.INFERENCE_SERVICE_URL),
    storageBackend: storageBackend(),
    durableStorage: persistentStorageConfigured(),
    inferenceServiceConfigured: Boolean(process.env.INFERENCE_SERVICE_URL && process.env.INFERENCE_SERVICE_TOKEN),
    timestamp: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
