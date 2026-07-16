import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { PterodactylPanel, type PterodactylPanelOptions } from '../panels/pterodactyl.ts';

export interface PterodactylSuiteOptions {
  readonly panel?: PterodactylPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function pterodactylSuite(options: PterodactylSuiteOptions = {}): Suite {
  return new Suite({
    panel: new PterodactylPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
