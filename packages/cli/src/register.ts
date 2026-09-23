import { registerGenerator } from "@apiweld/core";
import { heyApiGenerator } from "@apiweld/gen-heyapi";
import { oapiGenerator } from "@apiweld/gen-oapi";

let registered = false;

export function registerGenerators(): void {
  if (registered) return;
  registerGenerator(heyApiGenerator);
  registerGenerator(oapiGenerator);
  registered = true;
}
