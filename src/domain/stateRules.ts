import { CA_RULES, FEDERAL_RULES, type TimeRules } from './time';

/**
 * The hours rules for the state a company is in. A state with overtime or meal
 * rules of its own beyond federal law is listed here once they have been
 * checked against the state's own statute or agency; every other state works
 * under federal law (the FLSA).
 */
const STATE_RULES: Record<string, TimeRules> = {
  CA: CA_RULES,
};

export function rulesFor(state: string): TimeRules {
  return STATE_RULES[state] ?? FEDERAL_RULES;
}
