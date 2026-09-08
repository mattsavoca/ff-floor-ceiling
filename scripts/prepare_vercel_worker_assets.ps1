$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = Join-Path $repositoryRoot "web\api\producer-assets"
$rankOutputRoot = Join-Path $repositoryRoot "web\data\ffsimulator"
$outcomeSource = Join-Path $repositoryRoot "artifacts\ffsimulator\adp_outcomes.json"
$rankSourceRoot = Join-Path $repositoryRoot "artifacts\ffsimulator"
$v2ReleaseRoot = Join-Path $repositoryRoot "backtest_fbg_2023_2025\outputs\xgb_v2_quantile_projection"

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Assert-Equal {
  param(
    [object]$Actual,
    [object]$Expected,
    [string]$Message
  )
  if ($Actual -ne $Expected) {
    throw "$Message Expected '$Expected', found '$Actual'."
  }
}

if (-not (Test-Path -LiteralPath $outcomeSource)) {
  throw "Missing $outcomeSource. Run scripts/create_ffsimulator_snapshot.R first."
}
if (-not (Test-Path -LiteralPath (Join-Path $v2ReleaseRoot "metadata.json"))) {
  throw "Missing v2 model metadata: $(Join-Path $v2ReleaseRoot 'metadata.json')"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $rankOutputRoot | Out-Null
Copy-Item -LiteralPath $outcomeSource -Destination (Join-Path $outputRoot "adp_outcomes.json") -Force
Copy-Item -LiteralPath (Join-Path $rankSourceRoot "ffs_latest_rankings_week.csv") -Destination (Join-Path $rankOutputRoot "ffs_latest_rankings_week.csv") -Force
Copy-Item -LiteralPath (Join-Path $rankSourceRoot "ffs_latest_rankings_week.metadata.json") -Destination (Join-Path $rankOutputRoot "ffs_latest_rankings_week.metadata.json") -Force

$v2Metadata = Get-Content -Raw -LiteralPath (Join-Path $v2ReleaseRoot "metadata.json") | ConvertFrom-Json
Assert-Equal $v2Metadata.model_release "forecast-ppr-v2" "The active model release is invalid."
Assert-Equal $v2Metadata.artifact_version "xgb_v2_quantile_20260907" "The active artifact version is invalid."
Assert-Equal $v2Metadata.feature_version "fbg_rank_projection_v2" "The active feature version is invalid."
Assert-Equal $v2Metadata.scoring_contract_version "ppr_v1" "The active scoring contract is invalid."
Assert-Equal $v2Metadata.objective "reg:quantileerror" "The active objective is invalid."
Assert-Equal $v2Metadata.target_column "actual_score" "The active target is invalid."
if ([string]::IsNullOrWhiteSpace([string]$v2Metadata.runtime.xgboost)) {
  throw "The active model must declare its XGBoost version."
}
if (@($v2Metadata.training_seasons).Count -eq 0) {
  throw "The active model must declare its training seasons."
}
if ($null -eq $v2Metadata.validation_result -or $v2Metadata.validation_result.walk_forward -ne $true) {
  throw "The active model must declare a walk-forward validation result."
}
if (@($v2Metadata.quantile_alpha | ForEach-Object { [double]$_ }) -join "," -ne "0.15,0.5,0.85") {
  throw "The active model must declare quantile_alpha [0.15, 0.50, 0.85]."
}
if ($v2Metadata.one_prediction_call_returns_all_quantiles -ne $true) {
  throw "The active model must return all quantiles in one prediction call."
}

$activePositions = @("QB", "RB", "WR", "TE")
$v2ModelRoot = Join-Path $outputRoot "models\v2"
$v2ModelsDirectory = Join-Path $v2ModelRoot "models"
New-Item -ItemType Directory -Force -Path $v2ModelsDirectory | Out-Null
$activeRecords = foreach ($position in $activePositions) {
  $record = @($v2Metadata.model_records | Where-Object { ([string]$_.position).ToUpperInvariant() -eq $position })
  if ($record.Count -ne 1) {
    throw "Expected one v2 model record for $position."
  }
  $relativeModelPath = ([string]$record[0].model_path).Replace("/", "\")
  $sourceModelPath = Join-Path $v2ReleaseRoot $relativeModelPath
  if (-not (Test-Path -LiteralPath $sourceModelPath)) {
    throw "Missing v2 model file: $sourceModelPath"
  }
  $modelFileName = Split-Path $relativeModelPath -Leaf
  Copy-Item -LiteralPath $sourceModelPath -Destination (Join-Path $v2ModelsDirectory $modelFileName) -Force
  [ordered]@{
    target_season = [int]$record[0].target_season
    position = $position
    model_path = "models/$modelFileName"
    features = @($record[0].features)
    feature_count = [int]$record[0].feature_count
    training_rows = [int]$record[0].training_rows
  }
}
$activeFeatureMap = [ordered]@{}
foreach ($position in $activePositions) {
  $activeFeatureMap[$position] = @($v2Metadata.feature_names_by_position.$position)
  if ($activeFeatureMap[$position].Count -eq 0) {
    throw "The active model must declare features for $position."
  }
  $activeRecord = @($activeRecords | Where-Object { $_.position -eq $position })[0]
  $recordFeatures = @($activeRecord.features)
  if ($recordFeatures.Count -ne [int]$activeRecord.feature_count -or ($recordFeatures -join ",") -ne ($activeFeatureMap[$position] -join ",")) {
    throw "The active model feature list does not match the declared feature map for $position."
  }
  if ($activeFeatureMap[$position] -contains "n_projectors") {
    throw "n_projectors is not allowed in the active v2 asset metadata."
  }
}
$compactV2Metadata = [ordered]@{
  model_release = "forecast-ppr-v2"
  artifact_version = "xgb_v2_quantile_20260907"
  model_type = [string]$v2Metadata.model_type
  objective = "reg:quantileerror"
  target_column = "actual_score"
  quantile_alpha = @(0.15, 0.5, 0.85)
  quantile_output_columns = [ordered]@{ "0" = "p15"; "1" = "p50"; "2" = "p85" }
  one_prediction_call_returns_all_quantiles = $true
  feature_version = "fbg_rank_projection_v2"
  feature_names_by_position = $activeFeatureMap
  scoring_format = "PPR"
  scoring_contract_version = "ppr_v1"
  xgboost_version = [string]$v2Metadata.runtime.xgboost
  training_seasons = @($v2Metadata.training_seasons | ForEach-Object { [int]$_ })
  validation_result = $v2Metadata.validation_result
  target_season_policy = "newest target season less than or equal to the requested season"
  model_card_path = "model_card.md"
  comparison_metrics_path = "comparison_metrics.csv"
  comparison_report_path = "comparison_report.md"
  data_quality_report_path = "data_quality_report.json"
  outcome_errors_path = "outcome_errors.csv"
  quantile_crossings_path = "quantile_crossings.csv"
  model_records = @($activeRecords)
}
Write-Utf8NoBom (Join-Path $v2ModelRoot "metadata.json") ($compactV2Metadata | ConvertTo-Json -Depth 12)

$evidenceFiles = [ordered]@{
  "ml_model_card.md" = "model_card.md"
  "comparison_metrics.csv" = "comparison_metrics.csv"
  "comparison_report.md" = "comparison_report.md"
  "data_quality_report.json" = "data_quality_report.json"
  "outcome_errors.csv" = "outcome_errors.csv"
  "quantile_crossings.csv" = "quantile_crossings.csv"
  "predictions.parquet" = "predictions.parquet"
  "comparison_rows.parquet" = "comparison_rows.parquet"
}
foreach ($sourceName in $evidenceFiles.Keys) {
  $sourcePath = Join-Path $v2ReleaseRoot $sourceName
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Missing required v2 evidence file: $sourcePath"
  }
  Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $v2ModelRoot $evidenceFiles[$sourceName]) -Force
}

# Keep the old asset packs in the bundle so a deployment can roll back without
# rebuilding historical model files. They are served only by the legacy v1 routes.
$legacyAssetMetadata = @{}
foreach ($quantile in @("p15", "p85")) {
  $releaseRoot = Join-Path $repositoryRoot "backtest_fbg_2023_2025\outputs\xgb_${quantile}_projection"
  $metadataPath = Join-Path $releaseRoot "metadata.json"
  if (-not (Test-Path -LiteralPath $metadataPath)) {
    continue
  }
  $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
  $records = @($metadata.model_records | Where-Object {
    [int]$_.target_season -eq 2025 -and @("RB", "WR", "TE") -contains ([string]$_.position).ToUpperInvariant()
  })
  if ($records.Count -ne 3) {
    throw "Expected one legacy 2025 model for RB, WR, and TE in $metadataPath."
  }
  $quantileRoot = Join-Path $outputRoot "models\$quantile"
  $modelRoot = Join-Path $quantileRoot "models"
  New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
  $compactRecords = foreach ($record in $records) {
    $relativeModelPath = ([string]$record.model_path).Replace("/", "\")
    $sourceModelPath = Join-Path $releaseRoot $relativeModelPath
    if (-not (Test-Path -LiteralPath $sourceModelPath)) {
      throw "Missing legacy model file: $sourceModelPath"
    }
    $modelFileName = Split-Path $relativeModelPath -Leaf
    Copy-Item -LiteralPath $sourceModelPath -Destination (Join-Path $modelRoot $modelFileName) -Force
    [ordered]@{
      target_season = [int]$record.target_season
      position = ([string]$record.position).ToUpperInvariant()
      model_path = "models/$modelFileName"
      features = [string]$record.features
    }
  }
  $compactMetadata = [ordered]@{
    model_release = "forecast-ppr-v1"
    quantile_label = $quantile
    quantile_alpha = [double]$metadata.quantile_alpha
    scoring_contract_version = "ppr_v1"
    feature_version = "fbg_rank_projection_v1"
    target_season_policy = "newest target season less than or equal to the requested season"
    model_records = @($compactRecords)
  }
  Write-Utf8NoBom (Join-Path $quantileRoot "metadata.json") ($compactMetadata | ConvertTo-Json -Depth 8)
  $legacyAssetMetadata[$quantile] = $compactMetadata
}

$assetMetadata = [ordered]@{
  generated_at_utc = [DateTime]::UtcNow.ToString("o")
  active_model_release = "forecast-ppr-v2"
  active_artifact_version = "xgb_v2_quantile_20260907"
  active_feature_version = "fbg_rank_projection_v2"
  active_model_target = "actual_score"
  active_model_objective = "reg:quantileerror"
  active_scoring_format = "PPR"
  active_scoring_contract_version = "ppr_v1"
  active_model_positions = $activePositions
  active_model_quantiles = @("p15", "p50", "p85")
  active_endpoint = "/v2/models/predict"
  source_outcome_pool = "artifacts/ffsimulator/adp_outcomes.json"
  source_model_release = "backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection"
  active_xgboost_version = [string]$v2Metadata.runtime.xgboost
  active_training_seasons = @($v2Metadata.training_seasons | ForEach-Object { [int]$_ })
  active_validation_result = $v2Metadata.validation_result
  active_model_card_path = "models/v2/model_card.md"
  rollback_model_release = "forecast-ppr-v1"
  rollback_asset_paths = @("models/p15", "models/p85")
  legacy_v1_assets_present = ($legacyAssetMetadata.Count -eq 2)
}
Write-Utf8NoBom (Join-Path $outputRoot "metadata.json") ($assetMetadata | ConvertTo-Json -Depth 12)
Write-Output "Prepared active forecast-ppr-v2 assets and retained legacy v1 assets in $outputRoot"
