import {
	readPiPedstackConfigSync,
	resolveFeaturesConfig,
	type ResolvedFeaturesConfig,
} from "./config-types";

let startupFeaturesOverride: ResolvedFeaturesConfig | null = null;

/** @internal Test-only seam; production always resolves config.json. */
export function setStartupFeaturesForTests(
	features: ResolvedFeaturesConfig | null,
): void {
	startupFeaturesOverride = features;
}

/** Resolve runtime feature policy once at extension startup. */
export function resolveStartupFeatures(
	cwd = process.cwd(),
): ResolvedFeaturesConfig {
	return (
		startupFeaturesOverride ??
		resolveFeaturesConfig(readPiPedstackConfigSync(cwd))
	);
}
