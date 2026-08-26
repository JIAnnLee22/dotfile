local servers = require("plugins.config")
local capabilities = require("cmp_nvim_lsp").default_capabilities()

-- 诊断信息全局配置
vim.diagnostic.config({
  virtual_text = true,
  update_in_insert = true,
  float = {
    border = "rounded",
  },
})

-- LSP 附加到 buffer 后设置 buffer-local 快捷键
vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local bufnr = args.buf

    -- 格式化功能
    vim.keymap.set("n", "<leader>lf", function()
      require("conform").format({ bufnr = bufnr })
    end, { desc = "格式化", buffer = bufnr })

    -- 诊断跳转
    vim.keymap.set("n", "[d", function()
      vim.diagnostic.goto_prev()
    end, { desc = "上一个诊断", buffer = bufnr })

    vim.keymap.set("n", "]d", function()
      vim.diagnostic.goto_next()
    end, { desc = "下一个诊断", buffer = bufnr })

    vim.keymap.set("n", "<leader>dd", function()
      vim.diagnostic.open_float()
    end, { desc = "诊断信息", buffer = bufnr })
  end,
})

-- 使用 Neovim 0.11+ 原生 LSP 配置 API
for name, cfg in pairs(servers) do
  local config = vim.tbl_deep_extend("force", {
    capabilities = capabilities,
  }, cfg or {})

  vim.lsp.config(name, config)
  vim.lsp.enable(name)
end

-- Format (conform.nvim)
vim.api.nvim_create_autocmd("User", {
  pattern = "LazyFile",
  callback = function()
    require("conform").setup({
      formatters_by_ft = {
        lua = { "stylua" },
        python = { "black", "isort" },
        javascript = { "prettier" },
        typescript = { "prettier" },
        json = { "jq" },
        yaml = { "yamlfix" },
        markdown = { "markdownlint" },
        kotlin = { "ktlint" },
        java = {}, -- JDTLS 内置格式化
      },
      format_on_save = {
        timeout_ms = 500,
        lsp_fallback = true,
      },
    })
  end,
})