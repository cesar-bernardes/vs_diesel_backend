require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- ROTAS DE ESTOQUE ---
app.get('/api/produtos', async (req, res) => {
    const { data, error } = await supabase.from('produtos').select('*').order('descricao');
    if (error) return res.status(500).json({ error: error.message });
    const formatado = data.map(p => ({
        id: p.id, codigo: p.codigo, descricao: p.descricao, marca: p.marca,
        qtdeAtual: p.qtde_atual, precoCusto: p.preco_custo, precoVenda: p.preco_venda
    }));
    res.json(formatado);
});

app.post('/api/produtos', async (req, res) => {
    const { codigo, descricao, marca, qtde, precoCusto, unidade } = req.body;
    const { data, error } = await supabase.from('produtos').insert([{
        codigo: codigo.toUpperCase(), descricao, marca, unidade: unidade || 'UN',
        qtde_atual: parseInt(qtde), preco_custo: parseFloat(precoCusto), preco_venda: 0
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.put('/api/produtos/:id', async (req, res) => {
    const { id } = req.params;
    const { qtdeAtual, precoCusto, descricao, marca } = req.body;

    const { data, error } = await supabase
        .from('produtos')
        .update({ 
            qtde_atual: parseInt(qtdeAtual), 
            preco_custo: parseFloat(precoCusto),
            descricao: descricao,
            marca: marca
        })
        .eq('id', id)
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// NOVA ROTA: EXCLUIR PRODUTO (DELETE) COM VERIFICAÇÃO DE USO
app.delete('/api/produtos/:id', async (req, res) => {
    const { id } = req.params;

    // 1. Verificar se o produto está em uso em alguma OS (Tabela itens_os)
    // Usamos { count: 'exact', head: true } para ser mais rápido, só conta as linhas
    const { count, error: checkError } = await supabase
        .from('itens_os')
        .select('*', { count: 'exact', head: true })
        .eq('produto_id', id);

    if (checkError) return res.status(500).json({ error: checkError.message });

    // Se count > 0, significa que o produto está em alguma OS
    if (count > 0) {
        return res.status(400).json({ 
            error: 'Bloqueado: Este produto faz parte do histórico de Ordens de Serviço e não pode ser excluído.' 
        });
    }

    // 2. Se não estiver em uso, excluir
    const { error } = await supabase.from('produtos').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    
    res.json({ message: 'Produto excluído com sucesso' });
});

// --- ROTAS DE DESPESAS ---
app.get('/api/despesas', async (req, res) => {
    const { data, error } = await supabase.from('despesas').select('*').order('data_despesa', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/despesas', async (req, res) => {
    const { dataDespesa, numeroNf, tipoNf, valor, fornecedor, departamento, observacoes } = req.body;
    const { data, error } = await supabase.from('despesas').insert([{
        data_despesa: dataDespesa, numero_nf: numeroNf, tipo_nf: tipoNf,
        valor: parseFloat(valor), fornecedor, departamento, observacoes
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- ROTAS DE FATURAMENTO E CLIENTES ---
app.get('/api/clientes', async (req, res) => {
    const { data, error } = await supabase.from('clientes_empresas').select('*').order('nome_razao_social');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/clientes', async (req, res) => {
    const { nome, cnpj, telefone } = req.body;
    const { data, error } = await supabase.from('clientes_empresas').insert([{ 
        nome_razao_social: nome.toUpperCase(), cnpj_cpf: cnpj, telefone 
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.get('/api/faturamentos', async (req, res) => {
    const { data, error } = await supabase.from('faturamentos')
        .select(`*, clientes_empresas ( nome_razao_social, cnpj_cpf )`)
        .order('data_vencimento');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.post('/api/faturamentos/lancar', async (req, res) => {
    const { clienteId, valorTotal, qtdeParcelas, numeroDocumento, dataPrimeiroVencimento } = req.body;
    const parcelas = [];
    const valorParcela = parseFloat((valorTotal / qtdeParcelas).toFixed(2));
    let dataBase = new Date(dataPrimeiroVencimento + 'T12:00:00');

    for (let i = 1; i <= qtdeParcelas; i++) {
        let dataVenc = new Date(dataBase);
        dataVenc.setMonth(dataVenc.getMonth() + (i - 1));
        parcelas.push({
            cliente_id: clienteId, numero_documento: `${numeroDocumento}/${i}`,
            valor_parcela: valorParcela, numero_parcela: i, total_parcelas: qtdeParcelas,
            status: 'PENDENTE', data_lancamento: new Date(), data_vencimento: dataVenc
        });
    }
    const { data, error } = await supabase.from('faturamentos').insert(parcelas).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

app.put('/api/faturamentos/:id/pagar', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase.from('faturamentos').update({ status: 'PAGO' }).eq('id', id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- ROTAS NOVAS: ORDENS DE SERVIÇO (OS) ---

// Listar OS
app.get('/api/os', async (req, res) => {
    const { data, error } = await supabase.from('ordens_servico')
        .select(`*, clientes_empresas ( nome_razao_social )`)
        .order('id', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Criar OS
app.post('/api/os', async (req, res) => {
    const { clienteId, placa, veiculo, descricao } = req.body;
    const { data, error } = await supabase.from('ordens_servico').insert([{
        cliente_id: clienteId, placa: placa.toUpperCase(), veiculo, descricao_problema: descricao, status: 'ABERTA'
    }]).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Listar Itens de uma OS
app.get('/api/os/:id/itens', async (req, res) => {
    const { data, error } = await supabase.from('itens_os').select('*').eq('os_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Adicionar Item na OS (E baixar estoque se for peça)
app.post('/api/os/:id/itens', async (req, res) => {
    const { osId, produtoId, descricao, tipo, quantidade, preco } = req.body;
    const subtotal = parseFloat(quantidade) * parseFloat(preco);

    // Se for PEÇA, verificar e baixar estoque
    if (tipo === 'PECA' && produtoId) {
        const { data: prod } = await supabase.from('produtos').select('qtde_atual').eq('id', produtoId).single();
        if (prod) {
            await supabase.from('produtos').update({ qtde_atual: prod.qtde_atual - quantidade }).eq('id', produtoId);
        }
    }

    // Adicionar item
    const { data, error } = await supabase.from('itens_os').insert([{
        os_id: osId, produto_id: produtoId || null, descricao, tipo,
        quantidade, preco_un: preco, subtotal
    }]).select();

    // Atualizar total da OS
    const { data: itens } = await supabase.from('itens_os').select('subtotal').eq('os_id', osId);
    const novoTotal = itens.reduce((acc, item) => acc + item.subtotal, 0);
    await supabase.from('ordens_servico').update({ total: novoTotal }).eq('id', osId);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// Finalizar OS
app.put('/api/os/:id/finalizar', async (req, res) => {
    const { id } = req.params;
    const { data, error } = await supabase
        .from('ordens_servico')
        .update({ status: 'FINALIZADA', data_fechamento: new Date() })
        .eq('id', id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});
// NOVA ROTA: REMOVER ITEM DA OS (E DEVOLVER AO ESTOQUE)
app.delete('/api/os/itens/:id', async (req, res) => {
    const { id } = req.params;

    // 1. Buscar o item para saber qual produto e quantidade estornar
    const { data: item, error: findError } = await supabase
        .from('itens_os')
        .select('*')
        .eq('id', id)
        .single();
    
    if (findError) return res.status(500).json({ error: findError.message });

    // 2. Se for PEÇA, devolver a quantidade ao estoque (Estorno)
    if (item.tipo === 'PECA' && item.produto_id) {
        const { data: prod } = await supabase
            .from('produtos')
            .select('qtde_atual')
            .eq('id', item.produto_id)
            .single();
            
        if (prod) {
             await supabase
                .from('produtos')
                .update({ qtde_atual: prod.qtde_atual + item.quantidade })
                .eq('id', item.produto_id);
        }
    }

    // 3. Deletar o item da tabela
    const { error: deleteError } = await supabase
        .from('itens_os')
        .delete()
        .eq('id', id);
        
    if (deleteError) return res.status(500).json({ error: deleteError.message });

    // 4. Recalcular o valor total da OS e atualizar
    const { data: itens } = await supabase
        .from('itens_os')
        .select('subtotal')
        .eq('os_id', item.os_id);
        
    const novoTotal = itens ? itens.reduce((acc, i) => acc + i.subtotal, 0) : 0;
    
    await supabase
        .from('ordens_servico')
        .update({ total: novoTotal })
        .eq('id', item.os_id);

    res.json({ message: 'Item removido e estoque estornado com sucesso!' });
});

// --- CONFIGURAÇÃO DO SERVIDOR (COMPATÍVEL COM VERCEL) ---
const PORT = process.env.PORT || 8080;

// Só inicia o servidor se não estiver sendo importado (modo local)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Backend completo rodando na porta ${PORT}`);
    });
}

// Exporta o app para o Vercel conseguir usar (modo serverless)
module.exports = app;
//npx nodemon server.js