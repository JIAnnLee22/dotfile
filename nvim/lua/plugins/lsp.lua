local servers = require("plugins.config")
local lspconfig = require("lspconfig")
local capabilities = require("cmp_nvim_lsp").default_capabilities()

-- 诊断信息全局配置
vim.diagnostic.config({
  virtual_text = true,
  update_in_insert = true,
  float = {
    border = "rounded",
  },
})

-- 遍历配置，启动各 LSP 服务器
for name, cfg in pairs(servers) do
  local config = vim.tbl_deep_extend("force", {
    capabilities = capabilities,
    on_attach = function(client, bufnr)
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
  }, cfg or {})

  pcall(function()
    lspconfig[name].setup(config)
  end)
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