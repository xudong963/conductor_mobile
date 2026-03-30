export function normalizeTelegramCommand(input: string): string {
  const trimmed = input.trim();
  const command = trimmed.split(/\s+/, 1)[0] ?? trimmed;
  return command.split("@", 1)[0] ?? command;
}
