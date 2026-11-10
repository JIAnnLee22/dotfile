local M = {}

-- Prune generated directories during traversal, not after collecting every file.
local ignore_globs = {
	".git",
	"node_modules",
	".cache",
	"dist",
	"build",
	"*.tmp",
	"*.log",
}

function M.command(args)
	local cmd = { "rg", "--hidden", "--color=never" }
	for _, glob in ipairs(ignore_globs) do
		vim.list_extend(cmd, { "--glob", "!" .. glob })
	end
	return vim.list_extend(cmd, args)
end

return M
