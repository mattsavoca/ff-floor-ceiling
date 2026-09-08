param(
  [string]$BaseUrl = "http://localhost:3001",
  [int]$SimulationCount = 1000
)

$ErrorActionPreference = "Stop"

if ($SimulationCount -lt 100 -or $SimulationCount -gt 1000 -or $SimulationCount % 100 -ne 0) {
  throw "SimulationCount must be an integer from 100 through 1000 in steps of 100."
}

$baseUrl = $BaseUrl.TrimEnd("/")
$fixturePath = (Resolve-Path "tests/test-data/projection-set-weekly-all-2026-1-qb-rb-wr-te.csv").Path
$cookiePath = [System.IO.Path]::GetTempFileName()
$isolatedCookiePath = [System.IO.Path]::GetTempFileName()

function Invoke-Curl {
  param([string[]]$Arguments)

  $output = (& curl.exe -sS --max-time 120 @Arguments -w "`n%{http_code}" | Out-String).TrimEnd()
  $match = [regex]::Match($output, "`n(?<status>[0-9]{3})$")
  if (-not $match.Success) { throw "The HTTP request did not return a status code. Response: $output" }
  [pscustomobject]@{
    Status = [int]$match.Groups["status"].Value
    Body = $output.Substring(0, $match.Index).Trim()
  }
}

function Read-JsonBody {
  param($Response)
  if (-not $Response.Body) { return $null }
  try { return $Response.Body | ConvertFrom-Json } catch { throw "The response was not JSON: $($Response.Body)" }
}

function Read-Cookies {
  param([string]$Path)
  $lines = Get-Content -LiteralPath $Path
  $csrfLine = $lines | Where-Object { $_ -match "`tfc_csrf`t" } | Select-Object -First 1
  $sessionLine = $lines | Where-Object { $_ -match "`tfc_session`t" } | Select-Object -First 1
  if (-not $csrfLine -or -not $sessionLine) { throw "The session endpoint did not issue both cookies." }
  $csrf = (($csrfLine -split "\s+") | Select-Object -Last 1)
  $session = (($sessionLine -split "\s+") | Select-Object -Last 1)
  return @{ Csrf = $csrf; Header = "fc_csrf=$csrf; fc_session=$session" }
}

function Get-Api {
  param($Cookies, [string]$Path)
  $response = Invoke-Curl @("-H", "Cookie: $($Cookies.Header)", "$baseUrl$Path")
  [pscustomobject]@{ Response = $response; Data = Read-JsonBody $response }
}

function Send-Json {
  param($Cookies, [string]$Method, [string]$Path, $Payload)
  $body = $Payload | ConvertTo-Json -Compress -Depth 8
  $bodyPath = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($bodyPath, $body, [System.Text.UTF8Encoding]::new($false))
    $response = Invoke-Curl @(
      "-X", $Method,
      "-H", "Cookie: $($Cookies.Header)",
      "-H", "x-csrf-token: $($Cookies.Csrf)",
      "-H", "Content-Type: application/json",
      "--data-binary", "@$bodyPath",
      "$baseUrl$Path"
    )
    [pscustomobject]@{ Response = $response; Data = Read-JsonBody $response }
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Assert-FiniteNumber {
  param($Value, [string]$Message)
  $number = [double]$Value
  Assert-True ($null -ne $Value -and -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)) $Message
}

try {
  $sessionResponse = Invoke-Curl @("-c", $cookiePath, "$baseUrl/api/session")
  Assert-True ($sessionResponse.Status -eq 200) "The session endpoint failed."
  $cookies = Read-Cookies $cookiePath

  $uploadResponse = Invoke-Curl @(
    "-X", "POST",
    "-H", "Cookie: $($cookies.Header)",
    "-H", "x-csrf-token: $($cookies.Csrf)",
    "-F", "file=@$fixturePath;type=text/csv",
    "$baseUrl/api/uploads"
  )
  $upload = Read-JsonBody $uploadResponse
  Assert-True ($uploadResponse.Status -eq 201 -and $upload.uploadId) "The fixture upload failed: $($uploadResponse.Body)"
  Assert-True ($upload.report.accepted -gt 0) "The fixture has no accepted rows."
  Assert-True ($upload.report.sourceOrderUsed -eq $true) "The fixture did not use source-order rank derivation."
  $reportedPositionTotal = [int]$upload.report.positionCounts.QB + [int]$upload.report.positionCounts.RB + [int]$upload.report.positionCounts.WR + [int]$upload.report.positionCounts.TE
  Assert-True ($reportedPositionTotal -eq $upload.report.accepted) "The upload position counts do not sum to the accepted count."

  $runPayload = @{
    uploadId = $upload.uploadId
    inputRevision = $upload.sourceInputRevision
    metricDefinitionVersion = "ppr_v1_projection_formula"
    season = 2026
    week = 1
    simulationCount = $SimulationCount
    seed = 20260907
    scoringContractVersion = "ppr_v1"
  }
  $runResponse = Send-Json $cookies "POST" "/api/runs" $runPayload
  $run = $runResponse.Data
  Assert-True ($runResponse.Response.Status -eq 202 -and $run.runId) "The run was not created: $($runResponse.Response.Body)"
  $runId = $run.runId

  $current = $null
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    $currentResponse = Get-Api $cookies "/api/runs/$runId"
    $current = $currentResponse.Data
    if ($current.state -eq "Complete" -or $current.state -eq "Failed") { break }
    Start-Sleep -Milliseconds 500
  }
  Assert-True ($current.state -eq "Complete") "The fixture run did not complete: $($currentResponse.Response.Body)"

  $resultResponse = Get-Api $cookies "/api/runs/$runId/result"
  $result = $resultResponse.Data.result
  Assert-True ($resultResponse.Response.Status -eq 200 -and $result) "The complete result is missing."
  $rows = @($result.rows)
  $ids = @($rows | ForEach-Object stablePlayerId)
  $uniqueIds = @($ids | Select-Object -Unique)
  Assert-True ($result.schemaVersion -eq "forecast-result.v3") "The result schema is not forecast-result.v3."
  Assert-True ($result.metadata.modelRelease -eq "forecast-ppr-v2") "The result model release is not forecast-ppr-v2."
  Assert-True ($result.metadata.featureVersion -eq "fbg_rank_projection_v2") "The result feature version is not fbg_rank_projection_v2."
  Assert-True ($result.metadata.scoringFormat -eq "PPR" -and $result.metadata.scoringContractVersion -eq "ppr_v1") "The result scoring contract is not PPR ppr_v1."
  Assert-True ($result.metadata.modelTarget -eq "actual_score" -and $result.metadata.modelObjective -eq "reg:quantileerror") "The result model target or objective is wrong."
  Assert-True ($result.metadata.xgboostVersion -eq "3.4.1" -and $result.metadata.modelArtifactVersion -eq "xgb_v2_quantile_20260907") "The result model artifact metadata is wrong."
  Assert-True ((@($result.metadata.quantileLevels) -join ",") -eq "0.15,0.5,0.85") "The result quantile levels are wrong."
  Assert-True ($result.metadata.rangePolicyVersion -eq "direct_xgb_quantiles_v1" -and $result.metadata.inferenceEndpoint -eq "/v2/models/predict") "The result range policy metadata is wrong."
  Assert-True ($result.metadata.validationResult.walkForward -eq $true -and $result.metadata.validationResult.selectedModelRecords -eq 8) "The result validation metadata is wrong."
  Assert-True ($result.metadata.quantileCrossingCount -eq 0 -and @($result.metadata.quantileCrossingPlayerIds).Count -eq 0 -and $result.metadata.negativePredictionCount -eq 0 -and @($result.metadata.negativePredictionPlayerIds).Count -eq 0) "The result quantile or negative-prediction audit is not clean."
  Assert-True ($result.metadata.acceptedRowCount -eq $upload.report.accepted) "Accepted count changed between upload and result."
  Assert-True ($result.metadata.outputRowCount -eq $upload.report.accepted -and $rows.Count -eq $upload.report.accepted) "Output count does not match accepted count."
  Assert-True ($ids.Count -eq $uniqueIds.Count) "The result contains duplicate stable IDs."
  foreach ($position in @("QB", "RB", "WR", "TE")) {
    Assert-True ([int]$result.metadata.positionCounts.$position -eq [int]$upload.report.positionCounts.$position) "The result position count is wrong for $position."
  }

  foreach ($position in @("QB", "RB", "WR", "TE")) {
    $positionRanks = @($rows | Where-Object position -eq $position | Sort-Object sourceRowOrder | ForEach-Object ecr)
    $rankSequenceOk = $true
    for ($rankIndex = 0; $rankIndex -lt $positionRanks.Count; $rankIndex += 1) {
      if ([int]$positionRanks[$rankIndex] -ne $rankIndex + 1) { $rankSequenceOk = $false }
    }
    Assert-True $rankSequenceOk "The derived ECR sequence failed for $position."
  }

  foreach ($row in $rows) {
    $raw = $row.rawProjection
    $ppr = ([double]$raw.pass_yds / 25) + ([double]$raw.pass_td * 4) - [double]$raw.pass_int + ([double]$raw.pass_2pt * 2) + ([double]$raw.rush_yds / 10) + ([double]$raw.rush_td * 6) + ([double]$raw.rush_2pt * 2) + ([double]$raw.rec_yds / 10) + ([double]$raw.rec_td * 6) + ([double]$raw.rec_2pt * 2) + [double]$raw.rec_rec - ([double]$raw.fum_lost * 2)
    Assert-True ([math]::Abs($ppr - [double]$row.csvProjection) -lt 0.000001) "PPR parity failed for $($row.stablePlayerId)."
    Assert-FiniteNumber $row.xgbP15 "The v2 p15 value is missing for $($row.stablePlayerId)."
    Assert-FiniteNumber $row.xgbP50 "The v2 p50 value is missing for $($row.stablePlayerId)."
    Assert-FiniteNumber $row.xgbP85 "The v2 p85 value is missing for $($row.stablePlayerId)."
    Assert-True ([double]$row.xgbP15 -le [double]$row.xgbP50 -and [double]$row.xgbP50 -le [double]$row.xgbP85) "The XGBoost quantile order failed for $($row.stablePlayerId)."
    Assert-True ([math]::Abs([double]$row.floor - [double]$row.xgbP15) -lt 0.000001 -and [math]::Abs([double]$row.median - [double]$row.xgbP50) -lt 0.000001 -and [math]::Abs([double]$row.ceiling - [double]$row.xgbP85) -lt 0.000001) "The final range does not use the v2 quantiles for $($row.stablePlayerId)."
    Assert-True ([math]::Abs([double]$row.average - [double]$row.csvProjection) -lt 0.000001) "The average does not use the CSV PPR projection for $($row.stablePlayerId)."
    Assert-True ($row.floor -le $row.median -and $row.median -le $row.ceiling) "The final range order failed for $($row.stablePlayerId)."
    Assert-FiniteNumber $row.ffsimMean "The diagnostic ffsimulator output is missing for $($row.stablePlayerId)."
    Assert-True ($row.ffsimP15 -le $row.ffsimP50 -and $row.ffsimP50 -le $row.ffsimP85) "The diagnostic ffsimulator quantile order failed for $($row.stablePlayerId)."
    Assert-True ($row.valueSources.floor -eq "XGBoost p15" -and $row.valueSources.average -eq "CSV PPR projection" -and $row.valueSources.median -eq "XGBoost p50" -and $row.valueSources.ceiling -eq "XGBoost p85") "The v2 source labels are wrong for $($row.stablePlayerId)."
  }

  $rb = @($rows | Where-Object position -eq "RB")[0]
  Assert-True ($rb.rankSdMatch -in @("exact", "nearest")) "Rank uncertainty match type is missing."
  $modelCalls = @($current.externalModelCalls)
  $expectedProducerCallCount = 0
  foreach ($position in @("QB", "RB", "WR", "TE")) {
    if ([int]$upload.report.positionCounts.$position -gt 0) { $expectedProducerCallCount += 1 }
  }
  Assert-True ($modelCalls.Count -eq $expectedProducerCallCount -and @($modelCalls | Where-Object status -ne "complete").Count -eq 0) "The external model call report is incomplete."
  Assert-True (@($modelCalls | Where-Object model -ne "xgb_multi_quantile").Count -eq 0) "The run recorded a legacy quantile service call."
  $calledPositions = (@($modelCalls | Select-Object -ExpandProperty position | Sort-Object -Unique) -join ",")
  Assert-True ($calledPositions -eq "QB,RB,TE,WR") "The run did not record one v2 call for each populated position."
  Assert-True ($result.metadata.predictionCallCount -eq $modelCalls.Count -and $result.modelStatus.xgb.release -eq "forecast-ppr-v2" -and $result.modelStatus.xgb.featureVersion -eq "fbg_rank_projection_v2" -and $result.modelStatus.xgb.predictionCount -eq $rows.Count -and $result.modelStatus.xgb.predictionCallCount -eq $modelCalls.Count -and $result.modelStatus.xgb.quantileCrossingCount -eq 0 -and $result.modelStatus.xgb.negativePredictionCount -eq 0) "The v2 model status is incomplete."

  $overridePayload = @{ factor = 1; workloadFactor = 1; preset = "half"; inactive = $false; exclude = $false; edits = @{}; reason = "E2E half workload check" }
  $overrideResponse = Send-Json $cookies "PUT" "/api/runs/$runId/overrides/$($rb.stablePlayerId)" $overridePayload
  $saved = $overrideResponse.Data.overrideSet.records.PSObject.Properties[$rb.stablePlayerId].Value
  Assert-True ($overrideResponse.Response.Status -eq 200 -and $saved.revision -eq 1 -and $saved.runId -eq $runId -and $saved.uploadId -eq $upload.uploadId -and $saved.sourceInputRevision -eq $upload.sourceInputRevision) "Override linkage failed."
  Assert-True ([math]::Abs([double]$overrideResponse.Data.adjusted.median - ([double]$rb.median * 0.5)) -lt 0.000001) "Named preset precedence failed."
  $unchanged = @((Get-Api $cookies "/api/runs/$runId/result").Data.result.rows | Where-Object stablePlayerId -eq $rb.stablePlayerId)[0]
  Assert-True ([math]::Abs([double]$unchanged.median - [double]$rb.median) -lt 0.000001) "The original model result changed after an override."

  $badReason = Send-Json $cookies "PUT" "/api/runs/$runId/overrides/$($rb.stablePlayerId)" @{ factor = 1; edits = @{} }
  $unknownId = Send-Json $cookies "PUT" "/api/runs/$runId/overrides/unknown-player" @{ factor = 1; edits = @{}; reason = "unknown ID check" }
  Assert-True ($badReason.Response.Status -eq 400 -and $unknownId.Response.Status -eq 404) "Override validation did not reject bad requests."

  $secondRunResponse = Send-Json $cookies "POST" "/api/runs" (@{ uploadId = $upload.uploadId; inputRevision = $upload.sourceInputRevision; metricDefinitionVersion = "ppr_v1_projection_formula"; season = 2026; week = 1; simulationCount = $SimulationCount; seed = 20260908; scoringContractVersion = "ppr_v1" })
  $secondRun = $secondRunResponse.Data
  Assert-True ($secondRunResponse.Response.Status -eq 202 -and $secondRun.runId) "The second run was not created."
  $secondRunId = $secondRun.runId
  $secondCurrent = $null
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    $secondCurrent = (Get-Api $cookies "/api/runs/$secondRunId").Data
    if ($secondCurrent.state -eq "Complete" -or $secondCurrent.state -eq "Failed") { break }
    Start-Sleep -Milliseconds 500
  }
  Assert-True ($secondCurrent.state -eq "Complete") "The second fixture run did not complete."
  $emptyTargetSet = (Get-Api $cookies "/api/runs/$secondRunId/overrides").Data.overrideSet
  Assert-True (@($emptyTargetSet.records.PSObject.Properties).Count -eq 0) "A new run inherited overrides without an explicit copy."
  $copyResponse = Send-Json $cookies "POST" "/api/runs/$secondRunId/overrides/copy" @{ sourceRunId = $runId }
  Assert-True ($copyResponse.Response.Status -eq 200 -and @($copyResponse.Data.report.copiedPlayerIds) -contains $rb.stablePlayerId -and @($copyResponse.Data.report.unmatchedPlayerIds).Count -eq 0) "Explicit override copy failed: $($copyResponse.Response.Body)"
  $copied = (Get-Api $cookies "/api/runs/$secondRunId/overrides").Data.overrideSet
  Assert-True ($copied.runId -eq $secondRunId -and $copied.uploadId -eq $upload.uploadId -and $copied.records.PSObject.Properties[$rb.stablePlayerId].Value.sourceInputRevision -eq $upload.sourceInputRevision -and $copied.history[0].action -eq "copy") "Copied override linkage or history failed: $($copyResponse.Response.Body)"

  $resetResponse = Invoke-Curl @("-X", "DELETE", "-H", "Cookie: $($cookies.Header)", "-H", "x-csrf-token: $($cookies.Csrf)", "$baseUrl/api/runs/$runId/overrides/$($rb.stablePlayerId)")
  $reset = Read-JsonBody $resetResponse
  Assert-True ($resetResponse.Status -eq 200 -and @($reset.overrideSet.records.PSObject.Properties).Count -eq 0 -and @($reset.overrideSet.history | Where-Object action -eq "reset").Count -ge 1) "Override reset failed."

  $isolatedSessionResponse = Invoke-Curl @("-c", $isolatedCookiePath, "$baseUrl/api/session")
  Assert-True ($isolatedSessionResponse.Status -eq 200) "The isolated session could not be created."
  $isolatedCookies = Read-Cookies $isolatedCookiePath
  $isolatedRun = Get-Api $isolatedCookies "/api/runs/$runId"
  Assert-True ($isolatedRun.Response.Status -eq 404) "A second session could access the first session's run."
  $runList = (Get-Api $cookies "/api/runs").Data
  Assert-True ($runList.lastCompleteRunId -eq $secondRunId) "The newest complete run was not reported."

  $mix = $result.metadata.positionCounts | ConvertTo-Json -Compress
  $sourceSummary = ($rows | ForEach-Object { "$($_.stablePlayerId):$($_.position):$($_.valueSources.floor)|$($_.valueSources.average)|$($_.valueSources.median)|$($_.valueSources.ceiling)" }) -join "; "
  Write-Output ("E2E PASS run={0} second_run={1} upload={2} accepted={3} excluded={4} output={5} mix={6} calls={7} wall_ms={8} peak_memory_bytes={9} rank_match={10}" -f $runId, $secondRunId, $upload.uploadId, $result.metadata.acceptedRowCount, $result.metadata.excludedRowCount, $result.metadata.outputRowCount, $mix, $modelCalls.Count, $current.runtime.wallMs, $current.runtime.peakMemoryBytes, $rb.rankSdMatch)
  Write-Output "ROW SOURCES $sourceSummary"
  Write-Output ("OVERRIDE PASS copied={0} reset_history={1} isolated_http={2}" -f (@($copyResponse.Data.report.copiedPlayerIds).Count), (@($reset.overrideSet.history | Where-Object action -eq "reset").Count), $isolatedRun.Response.Status)
} finally {
  Remove-Item -LiteralPath $cookiePath, $isolatedCookiePath -Force -ErrorAction SilentlyContinue
}
