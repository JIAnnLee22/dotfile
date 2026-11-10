local search = require("search")
local command = search.command({ "--vimgrep", "--smart-case" })
vim.opt.grepprg = table.concat(vim.tbl_map(vim.fn.shellescape, command), " ")
vim.opt.grepformat = "%f:%l:%c:%m"

local job
local request = 0

local function grep(pattern)
	if not pattern or pattern == "" then
		return
	end

	request = request + 1
	local current = request
	if job then
		job:kill(15)
		job = nil
	end

	local cwd = vim.fn.getcwd()
	-- Absolute paths keep quickfix entries valid if the working directory changes.
	local cmd = vim.list_extend(vim.deepcopy(command), { "--", pattern, cwd })
	local ok, process = pcall(vim.system, cmd, { cwd = cwd, text = true }, function(result)
		vim.schedule(function()
			if current ~= request then
				return
			end
			job = nil
			if result.code > 1 or result.signal ~= 0 then
				vim.notify("Grep: " .. (result.stderr or "search failed"), vim.log.levels.ERROR)
			end

			-- Preserve partial matches even if rg reports unreadable files.
			vim.fn.setqflist({}, " ", {
				title = "Grep: " .. pattern,
				lines = vim.split(result.stdout or "", "\n", { plain = true, trimempty = true }),
				efm = vim.o.grepformat,
			})
			vim.cmd("copen")
		end)
	end)
	if ok then
		job = process
	else
		vim.notify("Grep: " .. tostring(process), vim.log.levels.ERROR)
	end
end

vim.api.nvim_create_user_command("Grep", function(args)
	grep(args.args)
end, { nargs = "+", desc = "Search asynchronously with ripgrep" })

vim.keymap.set("n", "<leader>g", function()
	vim.ui.input({ prompt = "Grep: " }, grep)
end, { silent = true })
