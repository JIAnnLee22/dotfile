-- lsp: 统一启用 + 补全 + 诊断
-- Kotlin/Android 仅使用 JetBrains 官方 kotlin_lsp；Java 使用 jdtls（Java >=21）。

-- Definition locations may point into Gradle source JARs. The Android helper
-- extracts a matching *-sources.jar into Neovim's cache before opening it.
local function goto_definition()
  if vim.tbl_contains({ 'kotlin', 'java', 'xml' }, vim.bo.filetype) then
    local ok, dependency = pcall(require, 'android.dependency')
    if ok then
      dependency.definition()
      return
    end
  end
  vim.lsp.buf.definition()
end

-- 补全选项：menuone 单候选也弹菜单，popup 显示文档，noselect 不自动选中
vim.o.completeopt = 'menu,menuone,noselect,popup,fuzzy'

-- 尝试启用 blink.cmp（已装于 pack/core/opt/blink.cmp），优先于原生 vim.lsp.completion
local blink_ok, blink = pcall(function()
  vim.cmd.packadd('blink.cmp')
  return require('blink.cmp')
end)

local capabilities = nil
if blink_ok then
  capabilities = blink.get_lsp_capabilities(nil, true)
  -- blink.cmp 默认配置（按需可在 lua/blink.lua 中覆盖）
  blink.setup({
    keymap = { preset = 'default' },
    appearance = { nerd_font_variant = 'mono' },
    completion = {
      documentation = { auto_show = false, auto_show_delay_ms = 400 },
      ghost_text = { enabled = false },
      menu = { auto_show = true },
    },
    signature = { enabled = true },
    sources = { default = { 'lsp', 'path', 'snippets', 'buffer' } },
    fuzzy = { implementation = 'prefer_rust' },
  })
else
  -- 回落：若 blink 不可用，确保原生补全的 capabilities 仍包含 snippet 等
  capabilities = vim.lsp.protocol.make_client_capabilities()
  capabilities.textDocument.completion.completionItem.snippetSupport = true
  capabilities.textDocument.completion.completionItem.resolveSupport = {
    properties = { 'documentation', 'detail', 'additionalTextEdits' },
  }
end

-- 将 capabilities 注入所有启用的 server（nvim 0.11+ 的 vim.lsp.config）。
-- vim.lsp.config is a setter/callable object, not a portable getter; always
-- use its merge form so this works on both supported Neovim versions.
local function inject_caps(name)
  if not capabilities then return end
  local ok, err = pcall(vim.lsp.config, name, { capabilities = capabilities })
  if not ok then
    vim.notify('Unable to configure LSP ' .. name .. ': ' .. tostring(err), vim.log.levels.WARN)
  end
end

for _, srv in ipairs({ 'lua_ls', 'tsgo', 'clangd', 'jdtls', 'kotlin_lsp' }) do
  inject_caps(srv)
end
-- 启用 servers：Kotlin/Android 仅用官方 kotlin_lsp，jdtls 仅对 java 生效
vim.lsp.enable({ 'lua_ls', 'tsgo', 'clangd', 'jdtls', 'kotlin_lsp' })

vim.diagnostic.config({
  virtual_text = true,
  underline = true,
  update_in_insert = false,
  severity_sort = true,
  float = { border = 'rounded', source = true },
})

-- 通用 LspAttach：补全、悬浮、诊断、inlayHint
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(ev)
    local client = vim.lsp.get_client_by_id(ev.data.client_id)
    if not client then return end
    local bufnr = ev.buf

    -- 原生补全：仅在 blink 未接管时启用 autotrigger
    if not blink_ok and client:supports_method('textDocument/completion') then
      pcall(vim.lsp.completion.enable, true, client.id, bufnr, { autotrigger = true })
    end

    -- inlay hints (若 server 支持)
    if client:supports_method('textDocument/inlayHint') then
      pcall(vim.lsp.inlay_hint.enable, true, { bufnr = bufnr })
    end

    -- 基础键位（不覆盖 android 的 gd/gf，android 插件会用 buffer-local 覆盖）
    local map = function(mode, lhs, rhs, desc)
      vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, silent = true, desc = desc })
    end
    map('n', 'K', vim.lsp.buf.hover, 'LSP hover')
    map('n', 'gD', goto_definition, 'LSP definition')
    map('n', 'gr', vim.lsp.buf.references, 'LSP references')
    map('n', 'gi', vim.lsp.buf.implementation, 'LSP implementation')
    map('n', '<leader>rn', vim.lsp.buf.rename, 'LSP rename')
    map({ 'n', 'v' }, '<leader>ca', vim.lsp.buf.code_action, 'LSP code action')
    map('n', '<leader>e', vim.diagnostic.open_float, 'Diagnostic float')
    map('n', '[d', function() vim.diagnostic.jump({ count = -1, float = true }) end, 'Prev diagnostic')
    map('n', ']d', function() vim.diagnostic.jump({ count = 1, float = true }) end, 'Next diagnostic')

    -- 手动触发补全：C-Space (blink 已有映射，此处仅为原生回落)
    if not blink_ok then
      map('i', '<C-Space>', '<C-x><C-o>', 'Trigger completion')
    end
  end,
})

-- 若用户手动 :packadd blink.cmp 后，需重启或执行此命令重算
vim.api.nvim_create_user_command('LspCapabilitiesInfo', function()
  local caps = capabilities and 'blink.cmp' or 'native'
  vim.notify('LSP capabilities source: ' .. caps .. '\nServers: lua_ls, tsgo, clangd, jdtls(+java21), kotlin_lsp(intellij-server)', vim.log.levels.INFO)
end, { desc = 'Show LSP completion source' })

vim.api.nvim_create_user_command('JavaLspInfo', function()
  local clients = vim.lsp.get_clients({ bufnr = 0, name = 'jdtls' })
  if #clients == 0 then
    vim.notify('jdtls is not attached to this buffer', vim.log.levels.WARN)
    return
  end
  local client = clients[1]
  local command = type(client.config.cmd) == 'table' and client.config.cmd[1] or 'managed by jdtls'
  local lines = {
    'root: ' .. (client.config.root_dir or 'unknown'),
    'server: ' .. (client.config.name or 'jdtls'),
    'command: ' .. (command or 'managed by jdtls'),
    'completion: ' .. (client:supports_method('textDocument/completion') and 'yes' or 'no'),
  }
  print(table.concat(lines, '\n'))
  vim.notify(table.concat(lines, '\n'), vim.log.levels.INFO)
end, { desc = 'Show Java jdtls status' })
