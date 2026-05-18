-- 开启的是 neovim 本身的插件
local map = vim.keymap.set

map("n", "<leader>uu", function()
  vim.cmd([[packad nvim.undotree]])
  require('undotree').open()
end, { desc = "Undotree" })
