import { StorageMigration, type StorageMigrationRunArgs } from "./base";
import type { MigrationResult, ProjectRecord } from "./transformers/types";
import { transformProjectV31ToV32 } from "./transformers/v31-to-v32";

export class V31toV32Migration extends StorageMigration {
	from = 31;
	to = 32;

	async run({
		project,
	}: StorageMigrationRunArgs): Promise<MigrationResult<ProjectRecord>> {
		return transformProjectV31ToV32({ project });
	}
}
