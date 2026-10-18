CREATE INDEX IF NOT EXISTS `sessions_agentic_tool_idx` ON `sessions` (`agentic_tool`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_scheduled_flag_idx` ON `sessions` (`scheduled_from_branch`);
