/** Combined Drive quota across accounts, plus how full that makes it. */
export function quotaTotals(accounts) {
  const used = accounts.reduce((sum, a) => sum + (a.quota_usage ?? 0), 0);
  const limit = accounts.reduce((sum, a) => sum + (a.quota_limit ?? 0), 0);
  return { used, limit, percent: limit ? (used / limit) * 100 : 0 };
}
