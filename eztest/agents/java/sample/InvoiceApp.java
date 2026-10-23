import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JTable;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.table.DefaultTableModel;
import java.awt.BorderLayout;
import java.awt.GridLayout;

/**
 * A tiny Swing invoice app used by EZTest's Java agent tests. With
 * -Dsample.variant=renamed the Save button reads "Store invoice" (same component name), to
 * exercise fingerprint healing.
 */
public class InvoiceApp {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(InvoiceApp::show);
    }

    static void show() {
        boolean renamed = "renamed".equals(System.getProperty("sample.variant"));
        JFrame f = new JFrame("Invoice Manager");
        f.setName("mainWindow");
        f.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);

        JMenuBar bar = new JMenuBar();
        JMenu file = new JMenu("File");
        JMenuItem clear = new JMenuItem("New Invoice");
        file.add(clear);
        bar.add(file);
        f.setJMenuBar(bar);

        JPanel form = new JPanel(new GridLayout(0, 2, 6, 6));
        form.setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
        JLabel customerLabel = new JLabel("Customer:");
        JTextField customer = new JTextField(20);
        customer.setName("customerField");
        customerLabel.setLabelFor(customer);
        JLabel amountLabel = new JLabel("Amount:");
        JTextField amount = new JTextField(10);
        amount.setName("amountField");
        amountLabel.setLabelFor(amount);
        JLabel currencyLabel = new JLabel("Currency:");
        JComboBox<String> currency = new JComboBox<>(new String[] {"USD", "EUR", "GBP"});
        currency.setName("currencyBox");
        currencyLabel.setLabelFor(currency);
        JCheckBox paid = new JCheckBox("Paid");
        paid.setName("paidCheck");
        JButton save = new JButton(renamed ? "Store invoice" : "Save");
        save.setName("saveBtn");
        form.add(customerLabel);
        form.add(customer);
        form.add(amountLabel);
        form.add(amount);
        form.add(currencyLabel);
        form.add(currency);
        form.add(paid);
        form.add(save);

        DefaultTableModel model = new DefaultTableModel(new Object[] {"Customer", "Amount", "Status"}, 0);
        JTable table = new JTable(model);
        table.setName("invoiceTable");
        JLabel status = new JLabel("Ready");
        status.setName("statusLabel");

        save.addActionListener(e -> {
            if (customer.getText().trim().isEmpty()) {
                status.setText("Customer is required");
                return;
            }
            model.addRow(new Object[] {customer.getText(), amount.getText() + " " + currency.getSelectedItem(), paid.isSelected() ? "Paid" : "Open"});
            status.setText("Saved invoice " + model.getRowCount() + " for " + customer.getText());
        });
        clear.addActionListener(e -> {
            customer.setText("");
            amount.setText("");
            paid.setSelected(false);
            status.setText("New invoice");
        });
        amount.addActionListener(e -> status.setText("Amount entered: " + amount.getText()));

        f.getContentPane().add(form, BorderLayout.NORTH);
        f.getContentPane().add(new JScrollPane(table), BorderLayout.CENTER);
        f.getContentPane().add(status, BorderLayout.SOUTH);
        f.setSize(520, 380);
        f.setLocation(40, 40);
        f.setVisible(true);
    }
}
