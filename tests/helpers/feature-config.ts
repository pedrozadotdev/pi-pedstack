import {
	DEFAULT_FEATURES,
	type ResolvedFeaturesConfig,
} from "../../extensions/ce-core/utils/config-types";

type FeatureOverrides = {
	[K in keyof ResolvedFeaturesConfig]?: Partial<ResolvedFeaturesConfig[K]>;
};

export function testFeatures(
	overrides: FeatureOverrides = {},
): ResolvedFeaturesConfig {
	return {
		stageGate: { ...DEFAULT_FEATURES.stageGate, ...overrides.stageGate },
		overengineering: {
			...DEFAULT_FEATURES.overengineering,
			...overrides.overengineering,
		},
		handoffReadiness: {
			...DEFAULT_FEATURES.handoffReadiness,
			...overrides.handoffReadiness,
		},
		docsVerification: {
			...DEFAULT_FEATURES.docsVerification,
			...overrides.docsVerification,
		},
		driftGuard: { ...DEFAULT_FEATURES.driftGuard, ...overrides.driftGuard },
		compactionGuard: {
			...DEFAULT_FEATURES.compactionGuard,
			...overrides.compactionGuard,
		},
		injectionScreen: {
			...DEFAULT_FEATURES.injectionScreen,
			...overrides.injectionScreen,
		},
		stageGuard: { ...DEFAULT_FEATURES.stageGuard, ...overrides.stageGuard },
	};
}
