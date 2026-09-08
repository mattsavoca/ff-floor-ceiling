import { NextResponse } from "next/server";
import { FEATURE_VERSION, MODEL_ARTIFACT_VERSION, MODEL_ENDPOINT_PATH, MODEL_OBJECTIVE, MODEL_POSITIONS, MODEL_RELEASE, MODEL_TARGET, MODEL_TRAINING_SEASONS, MODEL_VALIDATION_RESULT, QUANTILE_LEVELS, RESULT_SCHEMA_VERSION, SCORING_CONTRACT_VERSION, SCORING_FORMAT, XGBOOST_VERSION } from "@/lib/model-release";
import { persistentStorageConfigured, storageBackend } from "@/lib/server/store";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "floor-ceiling-web",
    version: "0.1.0",
    modelRelease: MODEL_RELEASE,
    modelArtifactVersion: MODEL_ARTIFACT_VERSION,
    featureVersion: FEATURE_VERSION,
    modelTarget: MODEL_TARGET,
    modelObjective: MODEL_OBJECTIVE,
    xgboostVersion: XGBOOST_VERSION,
    trainingSeasons: MODEL_TRAINING_SEASONS,
    validationResult: MODEL_VALIDATION_RESULT,
    scoringFormat: SCORING_FORMAT,
    scoringContractVersion: SCORING_CONTRACT_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    inferenceEndpoint: MODEL_ENDPOINT_PATH,
    modelPositions: MODEL_POSITIONS,
    quantileLevels: QUANTILE_LEVELS,
    publicDemo: true,
    persistentWorker: Boolean(process.env.INFERENCE_SERVICE_URL),
    storageBackend: storageBackend(),
    durableStorage: persistentStorageConfigured(),
    inferenceServiceConfigured: Boolean(process.env.INFERENCE_SERVICE_URL && process.env.INFERENCE_SERVICE_TOKEN),
    timestamp: new Date().toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
