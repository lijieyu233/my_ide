const {parentPort,workerData:d}=require('worker_threads');
// 隔离耗时SQL；取消线程不会把SQLite内存中的半成品写回用户文件。
function statement(sql,write){
  let clean='',quote='',comment='';
  for(let i=0;i<sql.length;i++){const c=sql[i],n=sql[i+1];if(comment){if(comment==='line'&&c==='\n')comment='';else if(comment==='block'&&c==='*'&&n==='/'){comment='';i++;}continue;}
    if(quote){if(c===quote){if(n===quote)i++;else quote='';}else if(c==='\\')i++;clean+=' ';continue;}
    if(c==='-'&&n==='-'){comment='line';i++;continue;}if(c==='/'&&n==='*'){comment='block';i++;continue;}
    if(['\'','"','`'].includes(c)){quote=c;clean+=' ';continue;}if(c==='$')throw Error('请使用参数绑定，暂不支持美元引号');clean+=c;
  }
  if(quote||comment==='block')throw Error('SQL引号或注释未闭合');
  clean=clean.trim().replace(/;\s*$/,'');if(clean.includes(';'))throw Error('每次只执行一条SQL；由服务管理事务');
  if(!write&&!/^(SELECT|WITH|EXPLAIN)\b/i.test(clean))throw Error('默认只允许只读查询；写入必须明确授权');
  if(!write&&/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|ATTACH|DETACH|PRAGMA|COPY|INTO|CALL|EXECUTE|SET|COMMIT|ROLLBACK)\b/i.test(clean))throw Error('只读查询含写入或会话控制语句');
  if(write&&!/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|WITH)\b/i.test(clean))throw Error('仅支持单条数据/结构变更，事务由服务提交或回滚');
}
function pack(columns,values){let bytes=0;const rows=[];for(const value of values){const row=Object.fromEntries(columns.map((c,i)=>[c,value[i] instanceof Uint8Array?'[BLOB '+value[i].length+']':typeof value[i]==='bigint'?String(value[i]):value[i]]));bytes+=Buffer.byteLength(JSON.stringify(row));if(rows.length>=5000||bytes>2*1024*1024)break;rows.push(row);}return {columns,rows,truncated:rows.length<values.length};}
async function run(){statement(d.sql,d.write);let db;const p=d.params||[];
  try{
    if(d.config.type==='sqlite'){
      const SQL=await require('sql.js')();db=new SQL.Database(d.bytes);if(!d.write)db.run('PRAGMA query_only=ON');db.run('BEGIN');
      const stmt=db.prepare(d.sql);const values=[];let columns=[];try{stmt.bind(p);columns=stmt.getColumnNames();while(stmt.step()){if(values.length<5001)values.push(stmt.get());else if(!d.write)break;}}finally{stmt.free();}
      const affected=db.getRowsModified();db.run('COMMIT');return {...pack(columns,values),affected,committed:!!d.write,...(d.write?{bytes:db.export()}:{} )};
    }
    if(d.config.type==='mysql'){
      db=await require('mysql2/promise').createConnection({...d.config,multipleStatements:false,connectTimeout:8000});
      await db.query(d.write?'START TRANSACTION':'START TRANSACTION READ ONLY');const [r,fields]=await db.execute(d.sql,p);await db.commit();
      return { ...pack(fields?.map(f=>f.name)||[],Array.isArray(r)?r.map(x=>fields.map(f=>x[f.name])):[]),affected:r.affectedRows||0,committed:!!d.write};
    }
    db=new (require('pg').Client)({...d.config,connectionTimeoutMillis:8000,statement_timeout:25000});await db.connect();await db.query(d.write?'BEGIN':'BEGIN READ ONLY');
    const r=await db.query(d.sql,p);await db.query('COMMIT');return {...pack(r.fields.map(f=>f.name),r.rows.map(x=>r.fields.map(f=>x[f.name]))),affected:r.rowCount||0,committed:!!d.write};
  }finally{if(db){try{if(d.config.type==='sqlite')db.close();else await db.end();}catch{}}}
}
if(parentPort)run().then(result=>parentPort.postMessage({ok:true,...result}),error=>parentPort.postMessage({ok:false,error:error.message,committed:d.write&&d.config.type!=='sqlite'?'unknown':false}));
module.exports={statement};
