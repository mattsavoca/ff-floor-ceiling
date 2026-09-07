export type ScheduleGame = {
  season: number;
  week: number;
  gameId: string;
  awayTeam: string;
  homeTeam: string;
};

const WEEK_ONE_2026: ScheduleGame[] = [
  ["NE", "SEA"], ["SF", "LA"], ["CHI", "CAR"], ["TB", "CIN"],
  ["NO", "DET"], ["BUF", "HOU"], ["BAL", "IND"], ["CLE", "JAX"],
  ["ATL", "PIT"], ["NYJ", "TEN"], ["ARI", "LAC"], ["MIA", "LV"],
  ["GB", "MIN"], ["WAS", "PHI"], ["DAL", "NYG"], ["DEN", "KC"],
].map(([awayTeam, homeTeam]) => ({
  season: 2026,
  week: 1,
  gameId: `2026_01_${awayTeam}_${homeTeam}`,
  awayTeam,
  homeTeam,
}));

const TEAM_ALIASES: Record<string, string> = {
  LAR: "LA",
  STL: "LA",
  OAK: "LV",
  LVR: "LV",
  SD: "LAC",
  JAC: "JAX",
  SFO: "SF",
  GBP: "GB",
  NEP: "NE",
  NOS: "NO",
  TBB: "TB",
  WSH: "WAS",
};

export function canonicalTeam(value: string) {
  const team = value.trim().toUpperCase();
  return TEAM_ALIASES[team] ?? team;
}

export function scheduleFor(season: number, week: number): ScheduleGame[] {
  if (season === 2026 && week === 1) return WEEK_ONE_2026.map((game) => ({ ...game }));
  return [];
}

export function attachOpponents(season: number, week: number, teams: string[]) {
  const games = scheduleFor(season, week);
  const byTeam = new Map<string, { opponent: string; gameId: string }>();
  for (const game of games) {
    byTeam.set(game.awayTeam, { opponent: game.homeTeam, gameId: game.gameId });
    byTeam.set(game.homeTeam, { opponent: game.awayTeam, gameId: game.gameId });
  }
  const missing = Array.from(new Set(teams.map(canonicalTeam))).filter((team) => !byTeam.has(team));
  if (missing.length) {
    throw new Error(`The approved schedule has no ${season} Week ${week} match for: ${missing.join(", ")}.`);
  }
  return new Map(Array.from(new Set(teams.map(canonicalTeam))).map((team) => [team, byTeam.get(team)!]));
}
