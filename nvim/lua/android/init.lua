local M = {}

local util = require("android.util")
local sdk = require("android.sdk")
local xml = require("android.xml")
local res = require("android.resources")

local default_opts = {
  -- sdk_dir = nil (auto),
  -- compile_sdk = nil (auto),
  keymaps = true,
  override_gd = true,
  -- key for unified jump; set false to not create mapping
  jump_key = "gd",
  -- extra keys
  sdk_key = "<leader>as",
  res_key = "<leader>ar",
}

local opts_cache = {}

function M.setup(user_opts)
  opts_cache = vim.tbl_deep_extend("force", default_opts, user_opts or {})

  -- User commands
  vim.api.nvim_create_user_command("AndroidGoto", function() xml.jump() end, { desc = "Android: smart goto (SDK / XML / resources)" })
  vim.api.nvim_create_user_command("AndroidSdk", function(args)
    local word = args.args ~= "" and args.args or nil
    sdk.goto_sdk(word)
  end, { nargs = "?", desc = "Jump to Android SDK source for word under cursor or given FQN" })
  vim.api.nvim_create_user_command("AndroidRes", function(args)
    -- :AndroidRes layout main_activity or string app_name
    local rt, rn = args.args:match("^(%S+)%s+(%S+)$")
    if rt and rn then
      res.open_resource(rt, rn)
    else
      vim.notify("Usage: :AndroidRes <type> <name>  e.g. :AndroidRes layout activity_main", vim.log.levels.INFO)
    end
  end, { nargs = "?", desc = "Jump to Android resource file" })
  vim.api.nvim_create_user_command("AndroidInfo", function()
    local root = util.find_project_root()
    local sdk_dir = util.get_sdk_dir({ root = root })
    local comp = util.get_compile_sdk(root)
    local sources = sdk_dir and util.get_sources_root(sdk_dir, comp) or nil
    local res_dirs = util.get_res_dirs(root)
    local lines = {
      "root: " .. root,
      "sdk_dir: " .. (sdk_dir or "NOT FOUND"),
      "compileSdk: " .. (comp or "unknown"),
      "sources: " .. (sources or "NOT FOUND"),
      "res dirs: " .. (next(res_dirs) and table.concat(res_dirs, ", ") or "none"),
      "sources exists: " .. (sources and (vim.fn.isdirectory(sources)==1 and "yes" or "no") or "n/a"),
    }
    vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
    print(table.concat(lines, "\n"))
  end, { desc = "Show Android project info (SDK/sources/res)" })

  if not opts_cache.keymaps then return end

  -- Buffer-local keymaps on relevant filetypes + global commands
  local grp = vim.api.nvim_create_augroup("AndroidLsp", { clear = true })

  -- For kotlin/java/xml attach smart jump
  vim.api.nvim_create_autocmd("FileType", {
    group = grp,
    pattern = { "kotlin", "java", "xml" },
    callback = function(ev)
      local bufnr = ev.buf
      -- <leader>ar for resource quick, <leader>as for sdk
      if opts_cache.sdk_key then
        vim.keymap.set("n", opts_cache.sdk_key, function() sdk.goto_sdk() end, { buffer = bufnr, desc = "Android: jump to SDK source" })
      end
      if opts_cache.res_key then
        vim.keymap.set("n", opts_cache.res_key, function()
          if not res.try_jump_resource() then vim.notify("no resource at cursor", vim.log.levels.INFO) end
        end, { buffer = bufnr, desc = "Android: jump to resource" })
      end

      if opts_cache.override_gd and opts_cache.jump_key then
        -- Override gd locally to use smart jump; keep original via gD
        -- Only map if not already mapped to avoid double
        local existing = vim.fn.maparg(opts_cache.jump_key, "n", false, true)
        -- create buffer-local override that tries android first, then LSP
        vim.keymap.set("n", opts_cache.jump_key, function() xml.jump() end, { buffer = bufnr, desc = "Android smart goto (SDK/XML/resources → LSP)" })
        vim.keymap.set("n", "gD", function() vim.lsp.buf.definition() end, { buffer = bufnr, desc = "LSP definition (original gd)" })
        -- optionally expose <leader>gd as original
        vim.keymap.set("n", "<leader>gd", function() vim.lsp.buf.definition() end, { buffer = bufnr, desc = "LSP definition" })
      end
    end,
  })

  -- also set for already-open buffers (when setup called after FileType)
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      local ft = vim.bo[buf].filetype
      if ft == "kotlin" or ft == "java" or ft == "xml" then
        vim.api.nvim_exec_autocmds("FileType", { buffer = buf, modeline = false })
      end
    end
  end

  -- includeexpr / gf enhancement: let gf jump to resource/layout files
  vim.api.nvim_create_autocmd("FileType", {
    group = grp,
    pattern = { "kotlin", "java", "xml" },
    callback = function(ev)
      -- set includeexpr to resolve @/ and R. ? keep simple: use our resource finder for gf
      -- We'll set a buffer-local mapping for gf as well
      vim.keymap.set("n", "gf", function()
        if res.try_jump_resource() then return end
        if xml.try_xml_jump() then return end
        if xml.try_code_jump() then return end
        -- fallback to default gf
        vim.cmd("normal! gf")
      end, { buffer = ev.buf, desc = "Android gf (resource/SDK → default)" })
    end,
  })
end

-- expose submodules for advanced usage
M.sdk = sdk
M.resources = res
M.xml = xml
M.util = util

return M
