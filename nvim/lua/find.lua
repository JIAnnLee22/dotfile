local search = require("search")
local cached_cwd, cached_files

local function invalidate()
	cached_cwd, cached_files = nil, nil
end

local group = vim.api.nvim_create_augroup("native_find_cache", { clear = true })
vim.api.nvim_create_autocmd("CmdlineEnter", {
	group = group,
	pattern = ":",
	callback = invalidate,
})
vim.api.nvim_create_autocmd({ "DirChanged", "BufWritePost", "BufFilePost", "FocusGained" }, {
	group = group,
	callback = invalidate,
})

function _G.native_find(text, _)
	local cwd = vim.fn.getcwd()
	if not cached_files or cached_cwd ~= cwd then
		local ok, result = pcall(function()
			return vim.system(search.command({ "--files", "--null" }), { cwd = cwd }):wait()
		end)
		if not ok or result.code > 1 then
			local message = ok and result.stderr or tostring(result)
			vim.schedule(function()
				vim.notify("Find: " .. message, vim.log.levels.ERROR)
			end)
			if not ok then
				return {}
			end
		end
		-- rg can still return useful files when part of the tree is unreadable.
		cached_files = vim.split(result.stdout or "", "\0", { plain = true, trimempty = true })
		table.sort(cached_files)
		cached_cwd = cwd
	end
	return text == "" and cached_files or vim.fn.matchfuzzy(cached_files, text)
end
vim.opt.findfunc = "v:lua.native_find"

vim.keymap.set("n", "<leader>f", ":find ", { silent = false })
