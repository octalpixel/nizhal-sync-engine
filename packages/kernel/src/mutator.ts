import type { MutatorDef, MutatorFn, MutatorRegistry, Schema } from "./types.js";

/** Define a single mutator: a validator + a function that runs optimistically on the
 * client and authoritatively on the server. The whole body is one transaction server-side. */
export function defineMutator<A>(schema: Schema<A>, fn: MutatorFn<A>): MutatorDef<A> {
  return { name: "", schema, fn };
}

/** Register mutators; the map key becomes each mutator's stable `name`. */
export function defineMutators<M extends Record<string, MutatorDef<any>>>(map: M): M {
  for (const [name, def] of Object.entries(map)) {
    def.name = name;
  }
  return map;
}

export type { MutatorDef, MutatorRegistry };
