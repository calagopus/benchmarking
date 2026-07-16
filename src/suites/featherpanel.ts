import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { FeatherPanelPanel, type FeatherPanelPanelOptions } from '../panels/featherpanel.ts';

export interface FeatherPanelSuiteOptions {
  readonly panel?: FeatherPanelPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function featherpanelSuite(options: FeatherPanelSuiteOptions = {}): Suite {
  return new Suite({
    panel: new FeatherPanelPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
