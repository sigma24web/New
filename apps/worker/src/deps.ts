/**
 * How the worker builds its model gateway (Checkpoint 7).
 *
 * There is no default that reaches a paid provider. `YEONJAE_PROVIDER_MODE` must be set explicitly, and
 * the only mode this checkpoint implements is `replay` — the same routing the CLI and every test use, which
 * serves recorded fixture responses and cannot issue a network call. A live mode is a separate, deliberate
 * decision with its own credential handling and budget review; leaving a `live` branch here that merely
 * lacked configuration would be an accident waiting to be triggered by an environment variable.
 */
import { readFileSync } from 'node:fs';
import { Gateway, MemoryBudget, ReplayProvider, type RoutingTable } from '@yeonjae/gateway';
import { ArtifactLlmOutputStore, type ChapterProductionDeps } from '@yeonjae/workflows';
import { PgAuditStore, type Pool } from '@yeonjae/db';

export type ProviderMode = 'replay';

export function providerModeFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderMode {
  const mode = env.YEONJAE_PROVIDER_MODE;
  if (mode === 'replay') return 'replay';
  throw new Error(
    "YEONJAE_PROVIDER_MODE must be set to 'replay'; the worker refuses to start without an explicit " +
      'provider mode so a misconfigured deployment cannot issue paid calls',
  );
}

/**
 * Routing for the replay provider: every model class resolves to the recorded fixture responses.
 *
 * The class letters are the gateway's own (`R` requirements, `P` prose, `M` evaluation, `C` checking,
 * `E` embedding). `E` is empty because no embedder exists yet (ADR-0035), and an empty route list makes
 * the gateway refuse an embedding call rather than silently serving a replayed one.
 */
export function replayRouting(): RoutingTable {
  const route = (modelId: string, family: string) => [
    {
      modelId,
      provider: 'replay',
      priority: 1,
      family,
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ];
  return {
    R: route('replay-r', 'alpha'),
    P: route('replay-p', 'alpha'),
    M: route('replay-m', 'beta'),
    C: route('replay-c', 'beta'),
    E: [],
  };
}

/**
 * Build the production dependency factory.
 *
 * The replay recording is read from `YEONJAE_REPLAY_FILE`. It is a required input in this mode: a replay
 * provider with no recording would fail every call, and failing at startup names the real problem.
 */
export function productionDeps(
  pool: Pool,
): (input: { workspaceId: string; projectId: string }) => ChapterProductionDeps {
  providerModeFromEnv();
  const replayFile = process.env.YEONJAE_REPLAY_FILE;
  if (!replayFile)
    throw new Error('YEONJAE_REPLAY_FILE must name a recording when YEONJAE_PROVIDER_MODE=replay');
  const recording = JSON.parse(readFileSync(replayFile, 'utf8')) as Record<string, unknown>;
  const budgetCents = Number(process.env.YEONJAE_BUDGET_CENTS ?? '100000');

  return ({ workspaceId, projectId }) => {
    const provider = new ReplayProvider(recording as never);
    return {
      pool,
      gateway: new Gateway({
        providers: new Map([['replay', provider]]),
        routing: replayRouting(),
        budget: new MemoryBudget(budgetCents),
        audit: new PgAuditStore(
          pool,
          { workspaceId, projectId },
          new ArtifactLlmOutputStore(pool, { workspaceId, projectId }),
        ),
      }),
    };
  };
}
