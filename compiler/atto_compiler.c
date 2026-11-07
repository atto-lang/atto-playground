/* AttoLang playground compiler M0: intentionally restricted integer language.
 * This compiler itself is a freestanding Wasm module; it emits DIFFERENT Wasm
 * modules from checked source rather than evaluating expressions in JS.
 * No libc, no heap, no imports, and no implicit host calls.
 */
#include <stdint.h>

#define INPUT_LIMIT 4096
#define OUTPUT_LIMIT 16384
#define CODE_LIMIT 8192
#define MAX_LOCALS 64

typedef struct { unsigned char *data; int used, cap; } Buffer;
typedef struct { const char *name; int length, mutable; } Local;
typedef struct { int type, start, length, line, column; int32_t number; } Token;

enum {
  T_END=0,T_IDENT,T_NUMBER,T_FNC,T_RETURN,T_CONST,T_LET,T_MUT,T_INT,
  T_LPAREN,T_RPAREN,T_LBRACE,T_RBRACE,T_SEMI,T_EQ,T_PLUS,T_MINUS,
  T_STAR,T_SLASH,T_ARROW,T_INVALID
};

static char input[INPUT_LIMIT+1];
static char error_text[256];
static unsigned char output[OUTPUT_LIMIT];
static unsigned char code[CODE_LIMIT];
static int output_length, error_line, error_column;
static int input_length, cursor, cursor_line, cursor_column;
static Token tok;
static Local locals[MAX_LOCALS];
static int locals_length;
static Buffer body;

static void message(const char *s) {
  int i=0;
  if(error_text[0]) return;
  while(s[i] && i<254) {error_text[i]=s[i];i++;}
  error_text[i]=0;
  error_line=tok.line; error_column=tok.column;
  if(error_line<1) error_line=1;
  if(error_column<1) error_column=1;
}
static int good(void) { return error_text[0]==0; }
static int alpha(char c) {return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='_';}
static int digit(char c) {return c>='0'&&c<='9';}
static int matches(int start,int length,const char *s) {
  int i=0; while(i<length&&s[i]&&input[start+i]==s[i]) i++;
  return i==length&&s[i]==0;
}
static int string_eq(const char *a,int na,const char *b,int nb) {
  if(na!=nb) return 0;
  for(int i=0;i<na;i++) if(a[i]!=b[i]) return 0;
  return 1;
}
static void advance_char(void) {
  if(cursor>=input_length)return;
  if(input[cursor]=='\n'){cursor_line++;cursor_column=1;} else cursor_column++;
  cursor++;
}
static void next(void) {
  while(cursor<input_length) {
    char c=input[cursor];
    if(c==' '||c=='\t'||c=='\n'||c=='\r') {advance_char();continue;}
    if(c=='/' && cursor+1<input_length && input[cursor+1]=='/') {
      while(cursor<input_length&&input[cursor]!='\n') advance_char();
      continue;
    }
    break;
  }
  tok.start=cursor; tok.line=cursor_line;tok.column=cursor_column;tok.length=0;tok.number=0;
  if(cursor>=input_length) {tok.type=T_END;return;}
  char c=input[cursor];
  if(alpha(c)) {
    advance_char();while(cursor<input_length&&(alpha(input[cursor])||digit(input[cursor])))advance_char();
    tok.length=cursor-tok.start;tok.type=T_IDENT;
    if(matches(tok.start,tok.length,"fnc"))tok.type=T_FNC;
    else if(matches(tok.start,tok.length,"return"))tok.type=T_RETURN;
    else if(matches(tok.start,tok.length,"const"))tok.type=T_CONST;
    else if(matches(tok.start,tok.length,"let"))tok.type=T_LET;
    else if(matches(tok.start,tok.length,"mut"))tok.type=T_MUT;
    else if(matches(tok.start,tok.length,"int"))tok.type=T_INT;
    return;
  }
  if(digit(c)) {
    uint32_t x=0;
    while(cursor<input_length&&digit(input[cursor])) {
      uint32_t y=(uint32_t)(input[cursor]-'0');
      if(x > (2147483647u-y)/10u) message("E_INTEGER_RANGE: integer must fit in signed i32");
      if(good()) x=x*10u+y;
      advance_char();
    }
    tok.type=T_NUMBER;tok.length=cursor-tok.start;tok.number=(int32_t)x;
    return;
  }
  advance_char();tok.length=1;
  switch(c) {
    case '(':tok.type=T_LPAREN;return; case ')':tok.type=T_RPAREN;return;
    case '{':tok.type=T_LBRACE;return; case '}':tok.type=T_RBRACE;return;
    case ';':tok.type=T_SEMI;return; case '=':tok.type=T_EQ;return;
    case '+':tok.type=T_PLUS;return; case '*':tok.type=T_STAR;return;
    case '/':tok.type=T_SLASH;return;
    case '-':
      if(cursor<input_length&&input[cursor]=='>') {advance_char();tok.length=2;tok.type=T_ARROW;}
      else tok.type=T_MINUS;
      return;
    default:tok.type=T_INVALID;message("E_TOKEN: unsupported token");return;
  }
}
static int expect(int type,const char *text) {
  if(!good())return 0;
  if(tok.type!=type){message(text);return 0;}
  next();return good();
}
static void put(Buffer *b,unsigned char value) {
  if(!good())return;
  if(b->used>=b->cap){message("E_OUTPUT_LIMIT: generated code too large");return;}
  b->data[b->used++]=value;
}
static void uleb(Buffer *b,uint32_t value) {
  do {unsigned char c=(unsigned char)(value&127u); value>>=7;
    if(value)c|=128u;put(b,c);
  }while(value&&good());
}
static void sleb(Buffer *b,int32_t value) {
  int more=1;
  while(more&&good()) {
    unsigned char byte=(unsigned char)(value&127);
    value >>= 7;
    int sign=(byte&64)!=0;
    if((value==0&&!sign)||(value==-1&&sign))more=0; else byte|=128;
    put(b,byte);
  }
}
static int lookup(const Token *t) {
  for(int i=0;i<locals_length;i++) {
    if(string_eq(input+t->start,t->length,locals[i].name,locals[i].length))return i;
  }
  return -1;
}
static void expression(void);
static void atom(void) {
  if(!good())return;
  if(tok.type==T_NUMBER){
    put(&body,0x41);sleb(&body,tok.number);next();return;
  }
  if(tok.type==T_IDENT){
    int i=lookup(&tok);
    if(i<0){message("E_UNBOUND: variable not declared");return;}
    put(&body,0x20);uleb(&body,(uint32_t)i);next();return;
  }
  if(tok.type==T_LPAREN){next();expression();expect(T_RPAREN,"E_PAREN: expected ')'");return;}
  if(tok.type==T_MINUS){
    next(); put(&body,0x41);sleb(&body,0);atom();put(&body,0x6b);return;
  }
  message("E_EXPRESSION: expected integer, variable or parenthesized expression");
}
static void multiplicative(void){
  atom();
  while(good()&&(tok.type==T_STAR||tok.type==T_SLASH)){
    int op=tok.type;next();atom();put(&body,op==T_STAR?0x6c:0x6d);
  }
}
static void expression(void){
  multiplicative();
  while(good()&&(tok.type==T_PLUS||tok.type==T_MINUS)){
    int op=tok.type;next();multiplicative();put(&body,op==T_PLUS?0x6a:0x6b);
  }
}
static void declaration(void){
  int mutable=0;
  if(tok.type==T_LET||tok.type==T_MUT){mutable=1;next();}
  else if(tok.type==T_CONST){next();}
  if(tok.type==T_INT) next();
  if(tok.type!=T_IDENT){message("E_DECL: expected variable identifier");return;}
  Token name=tok;
  if(lookup(&name)>=0){message("E_DUPLICATE: duplicate variable");return;}
  if(locals_length>=MAX_LOCALS){message("E_LOCALS_LIMIT: too many variables");return;}
  int index=locals_length++;
  locals[index].name=input+name.start;locals[index].length=name.length;
  locals[index].mutable=mutable;
  next();
  if(!expect(T_EQ,"E_DECL: expected '='"))return;
  expression();
  if(!expect(T_SEMI,"E_SEMICOLON: expected ';'"))return;
  put(&body,0x21);uleb(&body,(uint32_t)index);
}
static void assignment(void){
  int index=lookup(&tok);
  if(index<0){message("E_UNBOUND: variable not declared");return;}
  if(!locals[index].mutable){message("E_IMMUTABLE: rebinding requires let or mut");return;}
  next();
  if(!expect(T_EQ,"E_ASSIGN: expected '='"))return;
  expression();
  if(!expect(T_SEMI,"E_SEMICOLON: expected ';'"))return;
  put(&body,0x21);uleb(&body,(uint32_t)index);
}
static void emit_section(Buffer *out,unsigned char id,Buffer *payload){
  put(out,id);uleb(out,(uint32_t)payload->used);
  for(int i=0;i<payload->used&&good();i++)put(out,payload->data[i]);
}
static void module(void){
  /* Headers and sections are constructed separately, with bounded copies. */
  Buffer o={output,0,OUTPUT_LIMIT};
  static const unsigned char hdr[8]={0,97,115,109,1,0,0,0};
  for(int i=0;i<8;i++)put(&o,hdr[i]);
  unsigned char t[]={1,0x60,0,1,0x7f};
  Buffer type={t,5,5};emit_section(&o,1,&type);
  unsigned char f[]={1,0};Buffer fn={f,2,2};emit_section(&o,3,&fn);
  unsigned char e[]={1,4,'m','a','i','n',0,0};
  Buffer ex={e,8,8};emit_section(&o,7,&ex);
  /* Code payload: 1 function, body size, local declaration groups, instructions. */
  unsigned char p[CODE_LIMIT+32];Buffer cp={p,0,(int)sizeof(p)};
  uleb(&cp,1);
  unsigned int locals_groups=(locals_length>0)?1u:0u;
  unsigned char section_body[CODE_LIMIT+24];
  Buffer sb={section_body,0,(int)sizeof(section_body)};
  uleb(&sb,locals_groups);
  if(locals_groups){uleb(&sb,(uint32_t)locals_length);put(&sb,0x7f);}
  for(int i=0;i<body.used&&good();i++)put(&sb,body.data[i]);
  put(&sb,0x0b);
  uleb(&cp,(uint32_t)sb.used);
  for(int i=0;i<sb.used&&good();i++)put(&cp,sb.data[i]);
  emit_section(&o,10,&cp);
  if(good())output_length=o.used;
}
__attribute__((export_name("input_ptr"))) int input_ptr(void){return (int)(uintptr_t)input;}
__attribute__((export_name("input_capacity"))) int input_capacity(void){return INPUT_LIMIT;}
__attribute__((export_name("result_ptr"))) int result_ptr(void){return (int)(uintptr_t)output;}
__attribute__((export_name("result_length"))) int result_length(void){return output_length;}
__attribute__((export_name("error_ptr"))) int error_ptr(void){return (int)(uintptr_t)error_text;}
__attribute__((export_name("error_line_number"))) int error_line_number(void){return error_line;}
__attribute__((export_name("error_column_number"))) int error_column_number(void){return error_column;}
__attribute__((export_name("compile"))) int compile(int length){
  output_length=0;error_text[0]=0;error_line=1;error_column=1;
  cursor=0;cursor_line=1;cursor_column=1;locals_length=0;
  body.data=code;body.used=0;body.cap=CODE_LIMIT;
  tok.type=T_END;tok.line=1;tok.column=1;
  if(length<0||length>INPUT_LIMIT){message("E_SOURCE_LIMIT: source exceeds input capacity");return 1;}
  input_length=length;input[length]=0;
  for(int i=0;i<length;i++)if(!input[i]){message("E_NUL: source contains NUL");return 1;}
  next();
  if(!expect(T_FNC,"E_ENTRY: expected 'fnc'"))return 1;
  if(tok.type!=T_IDENT||!matches(tok.start,tok.length,"main")){
    message("E_ENTRY: expected main function");return 1;
  }
  next();
  if(!expect(T_LPAREN,"E_ENTRY: expected '('")||
     !expect(T_RPAREN,"E_ENTRY: expected ')'"))return 1;
  if(!expect(T_ARROW,"E_ENTRY: expected '->'"))return 1;
  if(!expect(T_INT,"E_ENTRY: expected int return type"))return 1;
  if(!expect(T_LBRACE,"E_ENTRY: expected '{'"))return 1;
  int returned=0;
  while(good()&&tok.type!=T_END&&tok.type!=T_RBRACE){
    if(tok.type==T_RETURN){
      next();expression();
      if(!expect(T_SEMI,"E_SEMICOLON: expected ';'"))break;
      put(&body,0x0f);returned=1;
      if(tok.type!=T_RBRACE && tok.type!=T_END)message("E_RETURN: return must be the final statement");
      break;
    }
    if(tok.type==T_CONST||tok.type==T_LET||tok.type==T_MUT||tok.type==T_INT){
      declaration();continue;
    }
    if(tok.type==T_IDENT){assignment();continue;}
    message("E_STATEMENT: unsupported statement");
  }
  if(!good())return 1;
  if(!returned){message("E_RETURN: main must end with return expression");return 1;}
  if(!expect(T_RBRACE,"E_ENTRY: expected '}'"))return 1;
  if(tok.type!=T_END){message("E_TRAILING: trailing tokens after main");return 1;}
  module();return good()?0:1;
}