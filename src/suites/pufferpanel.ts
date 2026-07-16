import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { PufferPanel, type PufferPanelOptions } from '../panels/pufferpanel.ts';

export interface PufferPanelSuiteOptions {
  readonly panel?: PufferPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function pufferpanelSuite(options: PufferPanelSuiteOptions = {}): Suite {
  return new Suite({
    panel: new PufferPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
