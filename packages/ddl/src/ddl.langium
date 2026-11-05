grammar DDL

entry Device:
    BOM? 'device' name=Name ('(' (properties+=Property (',' properties+=Property)* ','?)? ')')?
    '{' members+=Member* '}';
Property: name=Name ':' type=ValueType ('default' value=Expression)?;
Member: EnumDecl | RecordDecl | ConstantDecl | StateDecl | DerivedDecl | PinDecl | MemoryDecl | ChannelDecl | NotificationDecl | FunctionDecl | ProcessDecl | ReactionDecl | AssertStmt;
EnumDecl: 'enum' name=Name '{' members+=Name (',' members+=Name)* ','? '}';
RecordDecl: 'record' name=Name '{' fields+=RecordField* '}';
RecordField: name=Name ':' type=('number' | 'bool') ';';
ConstantDecl: 'const' name=Name (':' type=ValueType)? '=' value=Expression ';';
StateDecl: 'state' name=Name ':' type=ValueType '=' value=Expression ';';
DerivedDecl: 'derived' name=Name ':' type=ValueType '=' value=Expression ';';
PinDecl: 'pin' name=Name ('(' (options+=NamedArgument (',' options+=NamedArgument)* ','?)? ')')? ('=' value=Expression)? ';';
MemoryDecl: public?='public'? 'memory' name=Name '[' length=Expression ']' ';';
ChannelDecl: direction=('input'|'output') 'channel' name=Name ':' type=ValueType '(' options+=NamedArgument (',' options+=NamedArgument)* ','? ')' ';';
NotificationDecl: direction=('input'|'output') 'notification' name=Name ';';
FunctionDecl: pure?='pure'? 'fn' name=Name '(' (params+=Parameter (',' params+=Parameter)* ','?)? ')' (('->'|':') returns=ValueType)? body=Block;
Parameter: name=Name ':' type=ParameterType;
ParameterType: name=('pin'|'memory') | value=ValueType;
ValueType: name=('number'|'bool'|'string'|'bytes'|Name) optional?='?'?;
ProcessDecl: 'process' name=Name ('on' path=SourcePath)? body=Block;
ReactionDecl: 'reaction' name=Name 'on' path=SourcePath 'as' '(' previous=Name ',' current=Name ')' ('capture' captures+=Capture (',' captures+=Capture)* ','?)? body=Block;
Capture: name=Name '=' value=Expression;
SourcePath: parts+=Name ('.' parts+=Name)*;
Block: '{' statements+=Statement* '}';
Statement: LocalStmt | IntentStmt | AssignStmt | IfStmt | MatchStmt | WhileStmt | LoopStmt | BreakStmt | ContinueStmt | ReturnStmt | AwaitStmt | AssertStmt | RedirectStmt | CallStmt;
LocalStmt: binding=('const'|'let') name=Name (':' type=ValueType)? '=' value=Initializer ';';
Initializer: AwaitOperation | Expression;
AssignStmt: name=Name '=' value=Initializer ';';
IntentStmt: name=Name '.' 'intent' '<-' value=Expression ';';
CallStmt: value=Postfix ';';
IfStmt: 'if' condition=Expression yes=Block ('else' (no=Block | alternate=IfStmt))?;
MatchStmt: 'match' value=Expression '{' arms+=MatchArm+ '}';
MatchArm: pattern=Pattern '=>' body=Block;
Pattern: wildcard?='_' | sign=('+'|'-')? number=NUMBER | string=DDL_STRING | literal=('true'|'false'|'none') | enum=Name '.' member=Name;
WhileStmt: 'while' condition=Expression body=Block;
LoopStmt: 'loop' body=Block;
BreakStmt: {infer BreakStmt} 'break' ';';
ContinueStmt: {infer ContinueStmt} 'continue' ';';
ReturnStmt: 'return' value=Expression? ';';
AssertStmt: 'assert' condition=Expression (',' message=Expression)? ';';
RedirectStmt: 'redirect' '(' target=Expression (',' 'delay' ':' delay=Expression)? ')' ';';
AwaitStmt: value=AwaitOperation ';';
AwaitOperation: 'await' (ticks?='ticks' '(' ('duration' ':')? duration=Expression ','? ')' | channel=Name '.' 'receive' '(' ')');

type Expr = NumberLiteral | StringLiteral | Literal | BytesLiteral | IntentLiteral | RecordLiteral | Reference | Unary | Binary | Select | MemberAccess | IndexAccess | Call;
Expression returns Expr: Conditional;
Conditional returns Expr: Or ({infer Select.condition=current} '?' yes=Expression ':' no=Conditional)?;
Or returns Expr: And ({infer Binary.left=current} op='||' right=And)*;
And returns Expr: BitOr ({infer Binary.left=current} op='&&' right=BitOr)*;
BitOr returns Expr: BitXor ({infer Binary.left=current} op='|' right=BitXor)*;
BitXor returns Expr: BitAnd ({infer Binary.left=current} op='^' right=BitAnd)*;
BitAnd returns Expr: Equality ({infer Binary.left=current} op='&' right=Equality)*;
Equality returns Expr: Relational ({infer Binary.left=current} op=('=='|'!=') right=Relational)*;
Relational returns Expr: Shift ({infer Binary.left=current} op=('<'|'<='|'>'|'>=') right=Shift)*;
Shift returns Expr: Additive ({infer Binary.left=current} op=('<<'|'>>'|'>>>') right=Additive)*;
Additive returns Expr: Multiplicative ({infer Binary.left=current} op=('+'|'-') right=Multiplicative)*;
Multiplicative returns Expr: Exponent ({infer Binary.left=current} op=('*'|'/'|'%') right=Exponent)*;
Exponent returns Expr: UnaryPrefix | Power;
UnaryPrefix infers Unary: op=('+'|'-'|'!'|'~') value=Unary;
Unary returns Expr: UnaryPrefix | Postfix;
Power returns Expr: Postfix ({infer Binary.left=current} op='**' right=Exponent)?;
Postfix returns Expr: Primary (
    {infer MemberAccess.object=current} '.' member=Name |
    {infer IndexAccess.object=current} '[' index=Expression ']' |
    {infer Call.callee=current} '(' (args+=Argument (',' args+=Argument)* ','?)? ')'
)*;
Primary returns Expr: NumberLiteral | StringLiteral | Literal | BytesLiteral | IntentLiteral | RecordLiteral | Reference | '(' Expression ')';
NumberLiteral: value=NUMBER;
StringLiteral: value=DDL_STRING;
Literal: value=('true'|'false'|'none'|'NaN'|'Infinity');
BytesLiteral: 'bytes' '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']';
IntentLiteral: '[' (elements+=Expression (',' elements+=Expression)* ','?)? ']';
RecordLiteral: '{' (fields+=NamedArgument (',' fields+=NamedArgument)* ','?)? '}';
Reference: name=Name;
Argument: NamedArgument | PositionalArgument;
NamedArgument: name=ArgumentName ':' value=Expression;
ArgumentName returns string: Name | 'memory';
PositionalArgument: value=Expression;
Name returns string: ID | 'input' | 'output' | 'public' | 'channel' | 'notification' | 'start' | 'intent' | 'sample' | 'receive' | 'ticks' | 'duration' | 'delay';

terminal BOM: /\uFEFF/;
hidden terminal WS: /[ \t\r\n]+/;
terminal ID: /[A-Za-z_][A-Za-z0-9_]*/;
terminal NUMBER: /0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|[0-9](?:_?[0-9])*(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?/;
terminal DDL_STRING: /"(?:[^"\\\x00-\x1F]|\\(?:["\\nrt]|u[0-9a-fA-F]{4}|u\{[0-9a-fA-F]+\}))*"/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
