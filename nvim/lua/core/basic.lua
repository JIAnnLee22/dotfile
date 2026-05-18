vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.cursorline = true                       -- 高亮光标所在行
vim.opt.expandtab = true                        -- 使用空格代替 Tab
vim.opt.tabstop = 2                             -- Tab 键宽度为 2
vim.opt.shiftwidth = 2                          -- 缩进宽度为 2
vim.opt.wrap = false                            -- 不自动换行
vim.opt.scrolloff = 5                           -- 上下保留 5 行作为缓冲
vim.opt.signcolumn = "yes"                      -- 永远显示 sign column（诊断标记）
vim.opt.winborder = "rounded"                   -- 窗口边框样式
vim.opt.ignorecase = true                       -- 搜索忽略大小写
vim.opt.smartcase = true                        -- 当包含大写字母时，搜索区分大小写
vim.opt.hlsearch = false                        -- 搜索匹配不高亮
vim.opt.incsearch = true                        -- 增量搜索
vim.opt.foldmethod = "expr"                     -- 折叠方式使用表达式
vim.opt.foldexpr = "nvim_treesitter#foldexpr()" -- 使用 Treesitter 表达式折叠
vim.opt.foldlevel = 99                          -- 打开文件时默认不折叠
vim.opt.clipboard = "unnamedplus"

-- neovim 本身优化
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1
vim.opt.swapfile = false
vim.opt.shadafile = "NONE"

local function is_ssh()
  return vim.env.SSH_CONNECTION
      or vim.env.SSH_CLIENT
      or vim.env.SSH_TTY
end

if is_ssh() then
  local function paste()
    -- 从默认寄存器 "" 中获取内容，并按换行符分割
    return {
      vim.fn.split(vim.fn.getreg(""), "\n"),
      vim.fn.getregtype(""), -- 同时返回寄存器类型
    }
  end
  -- NOTE: 在远程ssh连接的终端中使用osc52
  -- 这里要说明的是flash在使用该osc52接管复制时，
  -- 无法使用flash的远程复制无法使用p粘贴请使用系统自带的粘贴快捷键
  -- 更推荐在远程链接时使用系统自带的粘贴快捷键。
  vim.g.clipboard = {
    name = 'OSC 52',
    copy = {
      ['+'] = require('vim.ui.clipboard.osc52').copy('+'),
      ['*'] = require('vim.ui.clipboard.osc52').copy('*'),
    },
    paste = {
      ['+'] = paste,
      ['*'] = paste,
    },
  }
end
