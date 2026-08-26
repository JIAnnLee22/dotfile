local M = {}

local install_list = {}

M.plugins_list = {
  editor = {
    { src = "https://github.com/stevearc/oil.nvim" }, -- 文件管理
  },
  lsp = {
    { src = "https://github.com/neovim/nvim-lspconfig" },          -- lsp配置
    { src = "https://github.com/stevearc/conform.nvim" },          -- 格式化配置
    { src = "https://github.com/hrsh7th/nvim-cmp" },               -- 补全核心
    { src = "https://github.com/hrsh7th/cmp-nvim-lsp" },           -- LSP 补全来源
    { src = "https://github.com/hrsh7th/cmp-buffer" },             -- buffer 补全
    { src = "https://github.com/hrsh7th/cmp-path" },               -- 路径补全
    { src = "https://github.com/hrsh7th/cmp-cmdline" },            -- 命令行补全
    { src = "https://github.com/L3MON4D3/LuaSnip" },              -- 代码片段引擎
    { src = "https://github.com/saadparwaiz1/cmp_luasnip" },       -- LuaSnip 补全来源
    { src = "https://github.com/onsails/lspkind.nvim" },           -- 补全菜单图标
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



-- 补全配置
local cmp_ok, cmp = pcall(require, "cmp")
local luasnip_ok, luasnip = pcall(require, "luasnip")
local lspkind_ok, lspkind = pcall(require, "lspkind")
if cmp_ok then
  if luasnip_ok then
    cmp.setup {
      snippet = {
        expand = function(args)
          luasnip.lsp_expand(args.body)
        end,
      },
      mapping = cmp.mapping.preset.insert {
        ["<C-Space>"] = cmp.mapping.complete(),
        ["<C-e>"] = cmp.mapping.abort(),
        ["<CR>"] = cmp.mapping.confirm({ select = true }),
        ["<Tab>"] = cmp.mapping(function(fallback)
          if cmp.visible() then
            cmp.select_next_item()
          elseif luasnip.expand_or_jumpable() then
            luasnip.expand_or_jump()
          else
            fallback()
          end
        end, { "i", "s" }),
        ["<S-Tab>"] = cmp.mapping(function(fallback)
          if cmp.visible() then
            cmp.select_prev_item()
          elseif luasnip.jumpable(-1) then
            luasnip.jump(-1)
          else
            fallback()
          end
        end, { "i", "s" }),
      },
      sources = cmp.config.sources {
        { name = "nvim_lsp" },
        { name = "luasnip" },
        { name = "buffer" },
        { name = "path" },
      },
      formatting = {
        format = lspkind_ok and lspkind.cmp_format {
          mode = "symbol",
          menu = {
            nvim_lsp = "LSP",
            luasnip = "Snip",
            buffer = "Buf",
            path = "Path",
          },
        } or nil,
      },
    }

    -- 命令行补全配置
    cmp.setup.cmdline(":", {
      mapping = cmp.mapping.preset.cmdline(),
      sources = cmp.config.sources(
        { { name = "path" } },
        { { name = "cmdline" } }
      ),
    })

    -- 搜索补全配置
    cmp.setup.cmdline("/", {
      mapping = cmp.mapping.preset.cmdline(),
      sources = { { name = "buffer" } },
    })
  end
end

-- 插件配置文件导入
require("plugins.editor")
require("plugins.lsp")
require("plugins.ui")
require("plugins.utils")
require("plugins.nvim")

return M
