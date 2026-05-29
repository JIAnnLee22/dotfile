local M = {}

local install_list = {}

M.plugins_list = {
  editor = {
    { src = "https://github.com/stevearc/oil.nvim" }, -- 文件管理
  },
  lsp = {
    { src = "https://github.com/mason-org/mason-lspconfig.nvim" }, -- lsp配置
    { src = "https://github.com/mason-org/mason.nvim" },           -- lsp配置
    { src = "https://github.com/neovim/nvim-lspconfig" },          -- lsp配置
    { src = "https://github.com/stevearc/conform.nvim" },          -- 格式化配置
  },
  ui = {
    { src = "https://github.com/mofiqul/dracula.nvim" },        -- 德古拉颜色主题
    { src = "https://github.com/nvim-tree/nvim-web-devicons" }, -- 文件图标
    { src = "https://github.com/akinsho/bufferline.nvim" },     -- bufferline
  },
  utils = {
    { src = "https://github.com/windwp/nvim-autopairs" },  -- 括号成对
    { src = "https://github.com/ibhagwan/fzf-lua" },       -- 搜索
    { src = "https://github.com/smoka7/hop.nvim" },        -- 跳转
    { src = "https://github.com/DrKJeff16/project.nvim" }, -- 项目跳转
    { src = "https://github.com/kylechui/nvim-surround" }, -- 快捷添加括号与引号
    { src = "https://github.com/folke/which-key.nvim" },   -- 快捷键显示
    { src = "https://github.com/Youthdreamer/obsess" },    -- 专注任务面板
  },
}

for _, group in pairs(M.plugins_list) do
  vim.list_extend(install_list, group)
end

vim.pack.add(install_list, { load = false })

vim.cmd([[colorscheme dracula]])



require("mason").setup()

require("mason-lspconfig").setup {
  automatic_enable = true
}

-- 插件配置文件导入
require("plugins.editor")
require("plugins.lsp")
require("plugins.ui")
require("plugins.utils")
require("plugins.nvim")

return M
