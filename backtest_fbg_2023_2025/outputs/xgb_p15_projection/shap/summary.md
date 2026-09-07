# SHAP explanation for direct XGBoost p15 models

The model output is raw PPR p15 points. SHAP values use the same unit.
Positive values increase the predicted p15. Negative values decrease it.
SHAP shows model association. It does not show causation.

## Global drivers

| Target season | Position | Feature | Mean absolute SHAP | Direction |
| --- | --- | --- | ---: | --- |
| 2024 | QB | `pass-sck` | 1.707 | higher values push p15 higher |
| 2024 | QB | `ecr` | 0.322 | higher values push p15 lower |
| 2024 | QB | `rush-car` | 0.305 | higher values push p15 higher |
| 2024 | QB | `consensus_projected_score` | 0.294 | higher values push p15 higher |
| 2024 | QB | `rank_max` | 0.284 | nonlinear or weak direction |
| 2024 | RB | `consensus_projected_score` | 0.791 | higher values push p15 higher |
| 2024 | RB | `rush-car` | 0.475 | higher values push p15 higher |
| 2024 | RB | `rec-yds` | 0.248 | higher values push p15 higher |
| 2024 | RB | `rec-rec` | 0.232 | higher values push p15 higher |
| 2024 | RB | `projection_fpts` | 0.221 | higher values push p15 higher |
| 2024 | TE | `rec-rec` | 0.469 | higher values push p15 higher |
| 2024 | TE | `rank_max` | 0.169 | higher values push p15 lower |
| 2024 | TE | `consensus_projected_score` | 0.088 | higher values push p15 higher |
| 2024 | TE | `rec-td` | 0.084 | higher values push p15 higher |
| 2024 | TE | `rec-tgt` | 0.055 | nonlinear or weak direction |
| 2024 | WR | `consensus_projected_score` | 0.443 | higher values push p15 higher |
| 2024 | WR | `rec-yds` | 0.315 | higher values push p15 higher |
| 2024 | WR | `projection_fpts` | 0.217 | higher values push p15 higher |
| 2024 | WR | `rec-td` | 0.156 | higher values push p15 higher |
| 2024 | WR | `rec-tgt` | 0.153 | higher values push p15 higher |
| 2025 | QB | `pass-sck` | 1.156 | higher values push p15 higher |
| 2025 | QB | `consensus_projected_score` | 0.626 | higher values push p15 higher |
| 2025 | QB | `pass-td` | 0.539 | higher values push p15 higher |
| 2025 | QB | `rank_sd` | 0.517 | higher values push p15 higher |
| 2025 | QB | `rush-td` | 0.445 | higher values push p15 lower |
| 2025 | RB | `rush-car` | 0.930 | higher values push p15 higher |
| 2025 | RB | `consensus_projected_score` | 0.696 | higher values push p15 higher |
| 2025 | RB | `rec-tgt` | 0.654 | higher values push p15 higher |
| 2025 | RB | `projection_fpts` | 0.342 | higher values push p15 higher |
| 2025 | RB | `rec-rec` | 0.181 | higher values push p15 higher |
| 2025 | TE | `rec-rec` | 0.351 | higher values push p15 higher |
| 2025 | TE | `consensus_projected_score` | 0.260 | higher values push p15 higher |
| 2025 | TE | `rec-td` | 0.232 | higher values push p15 higher |
| 2025 | TE | `rank_max` | 0.141 | higher values push p15 lower |
| 2025 | TE | `rec-yds` | 0.096 | higher values push p15 higher |
| 2025 | WR | `rec-tgt` | 1.479 | higher values push p15 higher |
| 2025 | WR | `rec-yds` | 0.251 | higher values push p15 higher |
| 2025 | WR | `rec-td` | 0.207 | higher values push p15 higher |
| 2025 | WR | `rec-rec` | 0.150 | higher values push p15 higher |
| 2025 | WR | `consensus_projected_score` | 0.144 | higher values push p15 higher |

## Method

- Explainer: `TreeExplainer` with tree-path-dependent perturbation.
- Models explained: 8.
- Held-out rows explained: 9,390.
- Maximum additivity error: 0.00000954 points.
- `consensus_projected_score` and `projection_fpts` are exact duplicate inputs in this dataset. Interpret their combined importance. Do not interpret either column's split as a unique effect.
- Correlated projection features can share or split attribution.
