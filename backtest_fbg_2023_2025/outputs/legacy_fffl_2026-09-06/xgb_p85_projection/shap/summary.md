# SHAP explanation for direct XGBoost p85 models

The model output is raw p85 fantasy points. SHAP values use the same unit.
Positive values increase the predicted p85. Negative values decrease it.
SHAP shows model association. It does not show causation.

## Global drivers

| Target season | Position | Feature | Mean absolute SHAP | Direction |
| --- | --- | --- | ---: | --- |
| 2024 | QB | `ecr` | 0.670 | higher values push p85 lower |
| 2024 | QB | `pass-cmp` | 0.590 | higher values push p85 lower |
| 2024 | QB | `pass-sck` | 0.490 | higher values push p85 higher |
| 2024 | QB | `consensus_projected_score` | 0.436 | higher values push p85 higher |
| 2024 | QB | `pass-int` | 0.337 | higher values push p85 lower |
| 2024 | RB | `consensus_projected_score` | 2.070 | higher values push p85 higher |
| 2024 | RB | `rush-yds` | 1.606 | higher values push p85 higher |
| 2024 | RB | `rush-1d` | 1.074 | higher values push p85 higher |
| 2024 | RB | `rush-car` | 1.036 | higher values push p85 higher |
| 2024 | RB | `rush-td` | 0.410 | higher values push p85 higher |
| 2024 | TE | `rec-tgt` | 1.187 | higher values push p85 higher |
| 2024 | TE | `rec-yds` | 0.937 | higher values push p85 higher |
| 2024 | TE | `rec-td` | 0.866 | higher values push p85 higher |
| 2024 | TE | `rec-rec` | 0.707 | higher values push p85 higher |
| 2024 | TE | `consensus_projected_score` | 0.524 | higher values push p85 higher |
| 2024 | WR | `consensus_projected_score` | 1.708 | higher values push p85 higher |
| 2024 | WR | `rec-rec` | 1.078 | higher values push p85 higher |
| 2024 | WR | `rec-td` | 1.005 | higher values push p85 higher |
| 2024 | WR | `rec-yds` | 0.825 | higher values push p85 higher |
| 2024 | WR | `consensus_rank` | 0.633 | higher values push p85 lower |
| 2025 | QB | `consensus_projected_score` | 0.902 | higher values push p85 higher |
| 2025 | QB | `pass-sck` | 0.741 | higher values push p85 higher |
| 2025 | QB | `n_projectors` | 0.553 | nonlinear or weak direction |
| 2025 | QB | `rank_min` | 0.524 | higher values push p85 lower |
| 2025 | QB | `ecr` | 0.374 | higher values push p85 lower |
| 2025 | RB | `consensus_projected_score` | 4.398 | higher values push p85 higher |
| 2025 | RB | `rush-1d` | 1.011 | higher values push p85 higher |
| 2025 | RB | `rush-yds` | 0.649 | higher values push p85 higher |
| 2025 | RB | `rec-tgt` | 0.287 | higher values push p85 lower |
| 2025 | RB | `ecr` | 0.277 | higher values push p85 higher |
| 2025 | TE | `rec-tgt` | 2.046 | higher values push p85 higher |
| 2025 | TE | `rec-yds` | 1.595 | higher values push p85 higher |
| 2025 | TE | `rec-td` | 1.129 | higher values push p85 higher |
| 2025 | TE | `consensus_projected_score` | 0.969 | higher values push p85 higher |
| 2025 | TE | `week` | 0.544 | higher values push p85 higher |
| 2025 | WR | `rec-yds` | 2.006 | higher values push p85 higher |
| 2025 | WR | `rec-rec` | 1.498 | higher values push p85 higher |
| 2025 | WR | `consensus_projected_score` | 1.349 | higher values push p85 higher |
| 2025 | WR | `rec-td` | 1.166 | higher values push p85 higher |
| 2025 | WR | `rec-1d` | 0.497 | higher values push p85 higher |

## Method

- Explainer: `TreeExplainer` with tree-path-dependent perturbation.
- Models explained: 8.
- Held-out rows explained: 9,390.
- Maximum additivity error: 0.00004578 points.
- `consensus_projected_score` and `projection_fpts` are exact duplicate inputs in this dataset. Interpret their combined importance. Do not interpret either column's split as a unique effect.
- Correlated projection features can share or split attribution.
