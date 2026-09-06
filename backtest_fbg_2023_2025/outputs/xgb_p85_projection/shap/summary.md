# SHAP explanation for direct XGBoost p85 models

The model output is raw PPR p85 points. SHAP values use the same unit.
Positive values increase the predicted p85. Negative values decrease it.
SHAP shows model association. It does not show causation.

## Global drivers

| Target season | Position | Feature | Mean absolute SHAP | Direction |
| --- | --- | --- | ---: | --- |
| 2024 | QB | `ecr` | 0.643 | higher values push p85 lower |
| 2024 | QB | `pass-cmp` | 0.585 | higher values push p85 lower |
| 2024 | QB | `pass-sck` | 0.506 | higher values push p85 higher |
| 2024 | QB | `consensus_projected_score` | 0.448 | higher values push p85 higher |
| 2024 | QB | `pass-int` | 0.325 | higher values push p85 lower |
| 2024 | RB | `consensus_projected_score` | 2.290 | higher values push p85 higher |
| 2024 | RB | `rush-yds` | 2.101 | higher values push p85 higher |
| 2024 | RB | `rush-car` | 0.812 | higher values push p85 higher |
| 2024 | RB | `rush-td` | 0.670 | higher values push p85 higher |
| 2024 | RB | `rush-1d` | 0.557 | higher values push p85 higher |
| 2024 | TE | `rec-tgt` | 1.648 | higher values push p85 higher |
| 2024 | TE | `rec-td` | 0.821 | higher values push p85 higher |
| 2024 | TE | `rec-yds` | 0.594 | higher values push p85 higher |
| 2024 | TE | `rec-rec` | 0.569 | higher values push p85 higher |
| 2024 | TE | `consensus_projected_score` | 0.433 | higher values push p85 higher |
| 2024 | WR | `rec-rec` | 1.720 | higher values push p85 higher |
| 2024 | WR | `consensus_projected_score` | 1.425 | higher values push p85 higher |
| 2024 | WR | `rec-yds` | 1.302 | higher values push p85 higher |
| 2024 | WR | `rec-td` | 1.152 | higher values push p85 higher |
| 2024 | WR | `consensus_rank` | 0.761 | higher values push p85 lower |
| 2025 | QB | `consensus_projected_score` | 0.901 | higher values push p85 higher |
| 2025 | QB | `pass-sck` | 0.744 | higher values push p85 higher |
| 2025 | QB | `n_projectors` | 0.553 | nonlinear or weak direction |
| 2025 | QB | `rank_min` | 0.513 | higher values push p85 lower |
| 2025 | QB | `ecr` | 0.368 | higher values push p85 lower |
| 2025 | RB | `consensus_projected_score` | 4.365 | higher values push p85 higher |
| 2025 | RB | `rush-yds` | 1.127 | higher values push p85 higher |
| 2025 | RB | `rush-1d` | 0.828 | higher values push p85 higher |
| 2025 | RB | `rec-tgt` | 0.369 | higher values push p85 higher |
| 2025 | RB | `ecr` | 0.353 | higher values push p85 higher |
| 2025 | TE | `rec-yds` | 2.126 | higher values push p85 higher |
| 2025 | TE | `rec-tgt` | 1.680 | higher values push p85 higher |
| 2025 | TE | `rec-td` | 1.089 | higher values push p85 higher |
| 2025 | TE | `consensus_projected_score` | 0.609 | higher values push p85 higher |
| 2025 | TE | `week` | 0.539 | higher values push p85 higher |
| 2025 | WR | `rec-yds` | 1.698 | higher values push p85 higher |
| 2025 | WR | `rec-rec` | 1.594 | higher values push p85 higher |
| 2025 | WR | `consensus_projected_score` | 1.395 | higher values push p85 higher |
| 2025 | WR | `rec-td` | 1.249 | higher values push p85 higher |
| 2025 | WR | `n_projectors` | 0.801 | higher values push p85 higher |

## Method

- Explainer: `TreeExplainer` with tree-path-dependent perturbation.
- Models explained: 8.
- Held-out rows explained: 9,390.
- Maximum additivity error: 0.00003052 points.
- `consensus_projected_score` and `projection_fpts` are exact duplicate inputs in this dataset. Interpret their combined importance. Do not interpret either column's split as a unique effect.
- Correlated projection features can share or split attribution.
