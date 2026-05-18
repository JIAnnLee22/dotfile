local servers = require("plugins.config") -- 选择使用什么lsp服务器与lsp配置

-- 补全提示
vim.api.nvim_create_autocmd("LspAttach", {
	callback = function(args)
		-- 诊断信息配置
		vim.diagnostic.config({ virtual_text = true, update_in_insert = true }) -- 行内文本提示
		local client = vim.lsp.get_client_by_id(args.data.client_id)
		if client:supports_method("textDocument/completion") and vim.lsp.completion then
			vim.opt.completeopt = { "menu", "menuone", "noinsert", "fuzzy", "popup" }
			vim.lsp.completion.enable(true, client.id, args.buf, { autotrigger = true })
			vim.keymap.set("i", "<C-Space>", function()
				vim.lsp.completion.get()
			end, { desc = "completion" })
		end

		-- 全键触发
		-- vim.api.nvim_create_autocmd("InsertCharPre", {
		--   callback = function()
		--     vim.lsp.completion.get()
		--   end,
		-- })

		vim.keymap.set("n", "<leader>d", function()
			vim.diagnostic.open_float()
		end, { desc = "诊断信息" })

		vim.keymap.set("n", "<leader>lf", function()
			require("conform").format({ bufnr = args.buf })
		end, { desc = "format" })
	end,
})

-- Format
vim.api.nvim_create_autocmd("User", {
	pattern = "LazyFile",
	callback = function()
		require("conform").setup({
			formatters_by_ft = {
				lua = { "stylua" },
			},
			format_on_save = {
				timeout_ms = 500, -- 格式化超时时间（毫秒）
				lsp_fallback = true, -- 如果没有可用的格式化器，使用 LSP 格式化
			},
		})
	end,
})
