$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location $projectPath

$rscriptPath = (Get-Command Rscript -ErrorAction Stop).Source
$python312Candidate = 'C:\Users\matts\AppData\Local\Programs\Python\Python312\python.exe'
$pythonPath = if (Test-Path -LiteralPath $python312Candidate) {
  $python312Candidate
} else {
  (Get-Command python -ErrorAction Stop).Source
}

function Invoke-Stage {
  param(
    [string]$Executable,
    [string[]]$Arguments,
    [string]$Name
  )
  Write-Host "Running $Name"
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE."
  }
}

Invoke-Stage $rscriptPath @("scripts/01_download_fbg.R") "FBG cache check"
Invoke-Stage $rscriptPath @("scripts/02_download_nflreadr.R") "nflreadr cache and PPR parity check"
Invoke-Stage $rscriptPath @("scripts/03_build_panel.R") "PPR panel build"
Invoke-Stage $rscriptPath @("scripts/04_run_player_backtest.R", "--n-simulations", "1000", "--rank-sd-multiplier", "0.5", "--qb-conditioning-strength", "0") "ffsimulator PPR backtest"
Invoke-Stage $rscriptPath @("scripts/04_run_player_backtest.R", "--n-simulations", "1000", "--rank-sd-multiplier", "0.5", "--qb-conditioning-strength", "0", "--output-tag", "_repro") "repeat seeded ffsimulator backtest"
Invoke-Stage $rscriptPath @("scripts/05_run_team_backtest.R") "team artifact rebuild"
Invoke-Stage $rscriptPath @("scripts/06_make_plots.R") "PPR chart rebuild"
Invoke-Stage $pythonPath @("scripts/08_xgb_p85_projection_experiment.py") "XGBoost PPR backtest"
Invoke-Stage $pythonPath @("scripts/08_xgb_p85_projection_experiment.py", "--max-configs", "1", "--nthread", "1", "--output-dir", "outputs/xgb_p85_repro_a") "repeat XGBoost smoke run A"
Invoke-Stage $pythonPath @("scripts/08_xgb_p85_projection_experiment.py", "--max-configs", "1", "--nthread", "1", "--output-dir", "outputs/xgb_p85_repro_b") "repeat XGBoost smoke run B"
Invoke-Stage $pythonPath @("scripts/08_xgb_p15_projection_experiment.py") "XGBoost PPR P15 floor backtest"
Invoke-Stage $pythonPath @("scripts/08_xgb_p15_projection_experiment.py", "--max-configs", "1", "--nthread", "1", "--output-dir", "outputs/xgb_p15_repro_a") "repeat P15 XGBoost smoke run A"
Invoke-Stage $pythonPath @("scripts/08_xgb_p15_projection_experiment.py", "--max-configs", "1", "--nthread", "1", "--output-dir", "outputs/xgb_p15_repro_b") "repeat P15 XGBoost smoke run B"
Invoke-Stage $pythonPath @("scripts/09_explain_xgb_p85_shap.py") "PPR SHAP rebuild"
Invoke-Stage $pythonPath @("scripts/09_explain_xgb_p15_shap.py") "PPR P15 SHAP rebuild"
Invoke-Stage $pythonPath @("scripts/10_build_calibration_page_data.py") "calibration page data rebuild"
Invoke-Stage $pythonPath @("scripts/12_check_reproducibility.py") "reproducibility receipt"
Invoke-Stage $pythonPath @("scripts/11_validate_ppr_run.py") "PPR validation gates"

Write-Host "Full PPR model and calibration workflow finished."
