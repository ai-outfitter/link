import type {
  GitHubRepository,
  GitHubRequestClient,
  GitHubScope,
  ObservationOptions,
  RepositoryObservation,
  ScopeInventory,
} from "./schema.js";

export async function listGitHubScope(
  _client: GitHubRequestClient,
  _scope: GitHubScope,
): Promise<ScopeInventory> {
  throw new Error("GitHub scope collection is not implemented");
}

export async function observeGitHubRepository(
  _client: GitHubRequestClient,
  _repository: GitHubRepository,
  _options: ObservationOptions = {},
): Promise<RepositoryObservation> {
  throw new Error("GitHub repository observation is not implemented");
}
