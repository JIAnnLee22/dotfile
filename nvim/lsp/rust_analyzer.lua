---@type vim.lsp.Config
return {
  cmd = { 'rust-analyzer' },
  filetypes = { 'rust' },
  root_markers = { 'rust-project.json', 'Cargo.toml' },
  workspace_required = true,
  settings = {
    ['rust-analyzer'] = {
      cargo = { buildScripts = { enable = true } },
      procMacro = { enable = true },
    },
  },
}
