-- Lsp 相关命令
vim.api.nvim_create_user_command('LspInfo', ':checkhealth vim.lsp', { desc = 'Alias to `:checkhealth vim.lsp`' })

vim.api.nvim_create_user_command('LspLog', function()
  vim.cmd(string.format('tabnew %s', vim.lsp.log.get_filename()))
end, {
  desc = 'Opens the Nvim LSP client log.',
})

-- 插件管理
-- 共享的补全函数
local function complete_plugin_names(ArgLead, CmdLine, CursorPos)
  local plugins_info = vim.pack.get()

  -- 使用 vim.iter 提取插件名称
  local plugin_names = vim.iter(plugins_info)
      :map(function(plugin)
        return plugin.spec.name
      end)
      :totable()

  -- 过滤匹配的插件名称
  return vim.iter(plugin_names)
      :filter(function(name)
        return vim.startswith(name, ArgLead)
      end)
      :totable()
end

-- PackUpdate 命令
vim.api.nvim_create_user_command('PackUpdate', function(opts)
  if opts.args == '' then
    vim.pack.update()
  else
    vim.pack.update(opts.fargs)
  end
end, {
  nargs = '*',
  desc = 'Update packages',
  complete = complete_plugin_names,
})

-- PackDel 命令
vim.api.nvim_create_user_command('PackDel', function(opts)
  if opts.args == '' then
    vim.pack.del({})
  else
    vim.pack.del(opts.fargs)
  end
end, {
  nargs = '*',
  desc = 'Delete packages',
  complete = complete_plugin_names,
})

-- PackGet 命令
vim.api.nvim_create_user_command('PackGet', function(opts)
  if opts.args == '' then
    local info = vim.pack.get()
    print(vim.inspect(info))
  else
    local info = vim.pack.get(opts.fargs)
    print(vim.inspect(info))
  end
end, {
  nargs = '*',
  desc = 'Get packages information',
  complete = complete_plugin_names,
})
