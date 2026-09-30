import { z } from "zod";

export const onboardingProjectBody = z.object({
  contextRoot: z.string().optional(),
  sourceRoots: z.array(z.string()).optional(),
  defaultHarness: z.string().optional(),
});
export type OnboardingProjectBody = z.input<typeof onboardingProjectBody>;

const port = z.number().int().min(1).max(65_535);
export const onboardingInitBody = z.object({
  host: z.string().optional(),
  ports: z.object({
    broker: port.optional(),
    web: port.optional(),
    pairing: port.optional(),
  }).optional(),
});
export type OnboardingInitBody = z.input<typeof onboardingInitBody>;

// POST /api/user patches the operator profile field by field; the route
// checks each field's type itself and drops what it does not recognize.
export const operatorProfilePatchBody = z.record(z.string(), z.unknown());
export type OperatorProfilePatchBody = z.input<typeof operatorProfilePatchBody>;
