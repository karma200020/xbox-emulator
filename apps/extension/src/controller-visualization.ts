import { AXIS_TARGETS, BUTTONS, type Profile, type Target } from "./profile-schema";

export interface ControllerPart {
  target: string;
  sources: string[];
  mapped: boolean;
}

export function controllerParts(profile: Profile): ControllerPart[] {
  const sources = new Map<string, string[]>();
  for (const [source, targets] of Object.entries(profile.key_bindings)) {
    addSources(sources, source, targets);
  }
  for (const [source, targets] of Object.entries(profile.mouse_bindings)) {
    addSources(sources, `Mouse ${source}`, targets);
  }
  const targets = [
    ...AXIS_TARGETS,
    ...Object.values(BUTTONS).map((button) => `button:${button}`),
  ];
  return targets.map((target) => ({
    target,
    sources: sources.get(target) ?? [],
    mapped: sources.has(target),
  }));
}

function addSources(map: Map<string, string[]>, source: string, targets: readonly Target[]): void {
  for (const target of targets) {
    const id = typeof target === "string" ? target : `button:${target.button}`;
    const current = map.get(id) ?? [];
    current.push(source);
    map.set(id, current);
  }
}
