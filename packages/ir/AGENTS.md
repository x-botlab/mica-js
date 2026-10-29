# IR

- Keep the interpreter as the semantic reference for JIT changes; preserve instruction steps, diagnostics and observable error behavior.
- Optimization passes must not alter step budgets or checkpoint semantics. Use focused interpreter/JIT comparisons when changing codegen.
