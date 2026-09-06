import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.features import add_opponent_qb_features, aggregate_fbg_draws  # noqa: E402
from dst_xgb.evaluate import evaluate_breakdowns, fit_market_baseline, predict_market_baseline  # noqa: E402
from dst_xgb.ingest import cached_pbp_seasons  # noqa: E402
from dst_xgb.schedule import build_team_game_schedule  # noqa: E402
from dst_xgb.scoring import build_dst_targets, points_allowed_score  # noqa: E402
from dst_xgb.train import grouped_temporal_split  # noqa: E402
from dst_xgb.teams import normalize_dst_rows  # noqa: E402


def _schedule() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "season": [2025],
            "week": [1],
            "game_id": ["2025_01_A_B"],
            "away_team": ["A"],
            "home_team": ["B"],
            "away_score": [10],
            "home_score": [24],
            "spread_line": [3.0],
            "total_line": [44.0],
            "away_rest": [7],
            "home_rest": [10],
            "away_moneyline": [120],
            "home_moneyline": [-140],
            "away_spread_odds": [-110],
            "home_spread_odds": [-110],
            "game_type": ["REG"],
            "gameday": ["2025-09-01"],
            "gametime": ["13:00"],
            "location": ["Home"],
            "roof": ["outdoors"],
            "div_game": [1],
        }
    )


def test_points_allowed_buckets_match_upstream_profile():
    assert [points_allowed_score(value) for value in [0, 1, 7, 14, 21, 28, 35]] == [10, 7, 4, 1, 0, -1, -4]


def test_provider_td_alias_becomes_canonical_dst():
    output = normalize_dst_rows(pd.DataFrame({"id": ["x"], "name": ["Team"], "pos": ["td"], "team": ["LAR"]}))
    assert output.loc[0, "position"] == "DST"
    assert output.loc[0, "team"] == "LA"


def test_pbp_target_assigns_events_to_the_correct_defense():
    pbp = pd.DataFrame(
        {
            "game_id": ["2025_01_A_B"] * 4,
            "defteam": ["B", "B", "A", "A"],
            "posteam": ["A", "A", "B", "B"],
            "sack": [1, 0, 0, 0],
            "interception": [0, 1, 0, 0],
            "fumble_lost": [0, 0, 1, 0],
            "return_touchdown": [0, 0, 0, 0],
            "safety": [0, 0, 0, 1],
            "defensive_two_point_conv": [0, 0, 0, 0],
            "return_team": [None, None, None, None],
        }
    )
    target = build_dst_targets(None, _schedule(), pbp=pbp).set_index("team")
    assert target.loc["B", "dst_fd_pts"] == 11
    assert target.loc["A", "dst_fd_pts"] == 4
    assert target.loc["A", "offensive_fumbles_lost"] == 1


def test_schedule_is_defense_oriented_and_preserves_rest_polarity():
    output = build_team_game_schedule(_schedule()).set_index("team")
    assert output.loc["A", "dst_home_game"] == 0
    assert output.loc["B", "dst_home_game"] == 1
    assert output.loc["A", "rest_differential"] == -3
    assert output.loc["B", "rest_differential"] == 3
    assert output.loc["B", "team_implied_total"] == 23.5


def test_fbg_draws_keep_one_row_per_simulation_and_team():
    draws = pd.DataFrame(
        {
            "season": [2025] * 8,
            "week": [1] * 8,
            "simulation_id": [1, 1, 1, 1, 2, 2, 2, 2],
            "position": ["QB", "RB", "QB", "RB"] * 2,
            "team": ["A", "A", "B", "B"] * 2,
            "projected_score": [20, 10, 15, 12, 18, 11, 16, 13],
            "simulation_mode": ["original_fbg"] * 8,
        }
    )
    mapping = build_team_game_schedule(_schedule())
    output = aggregate_fbg_draws(draws, schedule_team_games=mapping)
    assert len(output) == 4
    assert output.set_index(["simulation_id", "team"]).loc[(1, "A"), "sim_off_total_fd_points"] == 30
    assert output["game_id"].notna().all()


def test_dst_bridge_rejects_experimental_fbg_scenarios():
    draws = pd.DataFrame(
        {
            "season": [2025],
            "week": [1],
            "simulation_id": [1],
            "position": ["QB"],
            "team": ["A"],
            "projected_score": [20],
            "simulation_mode": ["qb_conditioned_experiment"],
        }
    )
    try:
        aggregate_fbg_draws(draws, schedule_team_games=build_team_game_schedule(_schedule()))
    except ValueError as error:
        assert "original FBG simulator path" in str(error)
    else:
        raise AssertionError("experimental scenarios were accepted")


def test_qb_history_excludes_the_target_week():
    schedule = _schedule().assign(week=2, game_id="2025_02_A_B", away_qb_id="qb-a", home_qb_id="qb-b")
    rows = []
    for play_id in range(1, 13):
        rows.append(
            {
                "season": 2025,
                "week": 1,
                "game_id": "2025_01_X_A",
                "play_id": play_id,
                "qb_dropback": 1,
                "pass_attempt": 1,
                "rush_attempt": 0,
                "passer_player_id": "qb-a",
                "rusher_player_id": None,
                "epa": 1.0,
                "cpoe": 2.0,
            }
        )
    rows.append(
        {
            "season": 2025,
            "week": 2,
            "game_id": "2025_02_A_B",
            "play_id": 1,
            "qb_dropback": 1,
            "pass_attempt": 1,
            "rush_attempt": 0,
            "passer_player_id": "qb-a",
            "rusher_player_id": None,
            "epa": 100.0,
            "cpoe": 100.0,
        }
    )
    output = add_opponent_qb_features(build_team_game_schedule(schedule), pd.DataFrame(rows))
    assert np.isclose(output.loc[output["team"].eq("B"), "opponent_qb_epa"].iloc[0], 1.0)
    assert np.isclose(output.loc[output["team"].eq("B"), "opponent_qb_cpoe"].iloc[0], 2.0)


def test_temporal_split_keeps_game_rows_together():
    frame = pd.DataFrame(
        {
            "season": [2023, 2023, 2023, 2023],
            "week": [1, 1, 2, 2],
            "game_id": ["g1", "g1", "g2", "g2"],
            "target": [1, 2, 3, 4],
            "game_date_time": pd.to_datetime(["2023-09-01", "2023-09-01", "2023-09-08", "2023-09-08"]),
        }
    )
    train, test = grouped_temporal_split(frame)
    assert set(train.game_id).isdisjoint(set(test.game_id))
    assert len(train) == 2
    assert len(test) == 2


def test_market_baseline_is_fit_from_prior_team_games(tmp_path):
    rows = []
    for game_number in range(1, 7):
        for team in ["A", "B"]:
            rows.append(
                {
                    "season": 2024,
                    "week": game_number,
                    "game_id": f"g{game_number}",
                    "team": team,
                    "target": 20.0 + game_number,
                    "opponent_implied_team_total": 20.0 + game_number,
                    "total_line": 40.0 + game_number,
                    "dst_home_game": int(team == "B"),
                    "rest_differential": 0.0,
                }
            )
    panel = pd.DataFrame(rows)
    model = fit_market_baseline(panel)
    predicted = predict_market_baseline(panel, model)
    assert model["fallback"] is False
    assert np.isfinite(predicted).all()
    breakdowns = evaluate_breakdowns(
        panel.assign(dst_fd_pts=panel["target"], dst_point=predicted, dst_p15=predicted, dst_p50=predicted, dst_p85=predicted)
    )
    assert set(breakdowns["breakdown"]) == {"opponent_total", "home_status", "roof", "wind"}


def test_cached_pbp_seasons_only_returns_prior_files(tmp_path):
    (tmp_path / "pbp").mkdir()
    for season in [2023, 2024, 2025, 2026]:
        (tmp_path / "pbp" / f"season={season}.parquet").touch()
    assert cached_pbp_seasons(tmp_path, before_season=2026) == [2023, 2024, 2025]
    assert cached_pbp_seasons(tmp_path, before_season=2026, start_season=2024) == [2024, 2025]
