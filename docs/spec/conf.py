project = "Mica 器件仿真规范"
language = "zh_CN"
root_doc = "index"
exclude_patterns = ["_build"]
nitpicky = True

latex_engine = "xelatex"
latex_documents = [("index", "mica-spec.tex", project, "", "manual")]
latex_elements = {
    "papersize": "a4paper",
    "pointsize": "11pt",
    "extraclassoptions": "oneside,openany",
    "fncychap": "",
    "fontpkg": r"\usepackage{lmodern}",
    "preamble": r"""
\usepackage[UTF8,scheme=chinese,fontset=fandol,heading=true]{ctex}
\ctexset{chapter={name={第,章},number=\arabic{chapter}}}
\setlength{\headheight}{14pt}
""",
}
