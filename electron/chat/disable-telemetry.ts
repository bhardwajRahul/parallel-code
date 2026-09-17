// Run before importing CopilotKit: its telemetry clients capture these at module load.
process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';
process.env.DO_NOT_TRACK = '1';
process.env.SCARF_ANALYTICS = 'false';
