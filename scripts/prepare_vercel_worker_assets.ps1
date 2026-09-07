$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputRoot = Join-Path $repositoryRoot "web\api\producer-assets"
$rankOutputRoot = Join-Path $repositoryRoot "web\data\ffsimulator"
$outcomeSource = Join-Path $repositoryRoot "artifacts\ffsimulator\adp_outcomes.json"
$rankSourceRoot = Join-Path $repositoryRoot "artifacts\ffsimulator"

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Content
  )
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

if (-not (Test-Path -LiteralPath $outcomeSource)) {
  throw "Missing $outcomeSource. Run scripts/create_ffsimulator_snapshot.R first."
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path $rankOutputRoot | Out-Null
Copy-Item -LiteralPath $outcomeSource -Destination (Join-Path $outputRoot "adp_outcomes.json") -Force
Copy-Item -LiteralPath (Join-Path $rankSourceRoot "ffs_latest_rankings_week.csv") -Destination (Join-Path $rankOutputRoot "ffs_latest_rankings_week.csv") -Force
Copy-Item -LiteralPath (Join-Path $rankSourceRoot "ffs_latest_rankings_week.metadata.json") -Destination (Join-Path $rankOutputRoot "ffs_latest_rankings_week.metadata.json") -Force

$featurePositions = @("RB", "WR", "TE")
$featureMetadata = @{}
foreach ($quantile in @("p15", "p85")) {
  $releaseRoot = Join-Path $repositoryRoot "backtest_fbg_2023_2025\outputs\xgb_${quantile}_projection"
  $metadataPath = Join-Path $releaseRoot "metadata.json"
  if (-not (Test-Path -LiteralPath $metadataPath)) {
    throw "Missing released model metadata: $metadataPath"
  }
  $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
  $records = @($metadata.model_records | Where-Object {
    [int]$_.target_season -eq 2025 -and $featurePositions -contains ([string]$_.position).ToUpperInvariant()
  })
  if ($records.Count -ne $featurePositions.Count) {
    throw "Expected one 2025 model for RB, WR, and TE in $metadataPath."
  }

  $quantileRoot = Join-Path $outputRoot "models\$quantile"
  $modelRoot = Join-Path $quantileRoot "models"
  New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
  $compactRecords = foreach ($record in $records) {
    $relativeModelPath = ([string]$record.model_path).Replace("/", "\")
    $sourceModelPath = Join-Path $releaseRoot $relativeModelPath
    if (-not (Test-Path -LiteralPath $sourceModelPath)) {
      throw "Missing released model file: $sourceModelPath"
    }
    Copy-Item -LiteralPath $sourceModelPath -Destination (Join-Path $modelRoot (Split-Path $relativeModelPath -Leaf)) -Force
    [ordered]@{
      target_season = [int]$record.target_season
      position = ([string]$record.position).ToUpperInvariant()
      model_path = "models/$(Split-Path $relativeModelPath -Leaf)"
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
  $featureMetadata[$quantile] = $compactMetadata
}

$assetMetadata = [ordered]@{
  generated_at_utc = [DateTime]::UtcNow.ToString("o")
  model_release = "forecast-ppr-v1"
  model_positions = $featurePositions
  model_quantiles = @("p15", "p85")
  source_outcome_pool = "artifacts/ffsimulator/adp_outcomes.json"
  source_model_release = "backtest_fbg_2023_2025/outputs/xgb_p15_projection and xgb_p85_projection"
}
Write-Utf8NoBom (Join-Path $outputRoot "metadata.json") ($assetMetadata | ConvertTo-Json -Depth 8)
Write-Output "Prepared Vercel producer assets in $outputRoot"
