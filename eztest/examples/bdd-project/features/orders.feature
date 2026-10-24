@orders
Feature: Orders
  Managers place orders for customers; the database is the record.

  Background:
    Given I am logged in as "manager"

  @smoke @req:ORD-1
  Scenario: Place an order
    When I order 3 "Gadget (49.50)" for "Contoso Ltd"
    Then the page contains "created"
    And the order total is 148.50
    And the database has the order for "Contoso Ltd"

  Rule: Customers come from the database

    Scenario: The EU customers
      Then the EU customers are:
        | name              | credit_limit |
        | Contoso Ltd       | 25000        |
        | Northwind Traders | 12000        |

    Scenario Outline: Order <qty> <product> for <customer>
      When I order <qty> "<product>" for "<customer>"
      Then the order total is <total>

      @eu
      Examples: EU customers
        | customer          | product          | qty | total |
        | Contoso Ltd       | Widget (19.99)   | 2   | 39.98 |
        | Northwind Traders | Doohickey (5.25) | 4   | 21.00 |

      @us @wip
      Examples: US customers
        | customer     | product        | qty | total |
        | Fabrikam Inc | Gadget (49.50) | 1   | 49.50 |
